const STOPWORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  "aren't",
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  "can't",
  'cannot',
  'could',
  "couldn't",
  'did',
  "didn't",
  'do',
  'does',
  "doesn't",
  'doing',
  "don't",
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  "hadn't",
  'has',
  "hasn't",
  'have',
  "haven't",
  'having',
  'he',
  "he'd",
  "he'll",
  "he's",
  'her',
  'here',
  "here's",
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  "how's",
  'i',
  "i'd",
  "i'll",
  "i'm",
  "i've",
  'if',
  'in',
  'into',
  'is',
  "isn't",
  'it',
  "it's",
  'its',
  'itself',
  "let's",
  'me',
  'more',
  'most',
  "mustn't",
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'ought',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'same',
  "shan't",
  'she',
  "she'd",
  "she'll",
  "she's",
  'should',
  "shouldn't",
  'so',
  'some',
  'such',
  'than',
  'that',
  "that's",
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  "there's",
  'these',
  'they',
  "they'd",
  "they'll",
  "they're",
  "they've",
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'was',
  "wasn't",
  'we',
  "we'd",
  "we'll",
  "we're",
  "we've",
  'were',
  "weren't",
  'what',
  "what's",
  'when',
  "when's",
  'where',
  "where's",
  'which',
  'while',
  'who',
  "who's",
  'whom',
  'why',
  "why's",
  'with',
  "won't",
  'would',
  "wouldn't",
  'you',
  "you'd",
  "you'll",
  "you're",
  "you've",
  'your',
  'yours',
  'yourself',
  'yourselves',
]);
/**
 * LocalEmbeddingEngine implements a native local approach to text embedding
 * using Feature Hashing (the hashing trick). This provides a deterministic,
 * zero-dependency way to generate vectors for semantic search and cosine similarity.
 */
class LocalEmbeddingEngine {
  dimensions;
  constructor(dimensions = 768) {
    this.dimensions = dimensions;
  }
  /**
   * Generates a fixed-size vector for a given text string.
   */
  embed(text) {
    const vector = new Array(this.dimensions).fill(0);
    const trimmed = text.trim();
    if (!trimmed) return vector;
    // Tokenization: Lowercase, split by non-alphanumeric characters, and filter stopwords
    const tokens = trimmed
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0 && !STOPWORDS.has(t));
    if (tokens.length === 0) return vector;
    for (const token of tokens) {
      // Hashing Trick: Map each token to a vector index
      const hash = this.hashString(token);
      const index = Math.abs(hash % this.dimensions);
      // Use the hash sign for better distribution (signed hashing)
      const sign = hash % 2 === 0 ? 1 : -1;
      vector[index] += sign;
    }
    // L2 Normalization (Unit Length) for better cosine similarity results
    return this.normalize(vector);
  }
  // FNV-1a hash algorithm for better distribution and fewer collisions
  hashString(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash;
  }
  normalize(v) {
    let magSq = 0;
    for (const x of v) magSq += x * x;
    if (magSq === 0) return v;
    const mag = Math.sqrt(magSq);
    const epsilon = 1e-10;
    const finalMag = Math.max(mag, epsilon);
    return v.map((x) => x / finalMag);
  }
}
const DEFAULT_DIMENSIONS = 768;
/**
 * AiService provides a native local approach to embeddings and semantic search.
 * It removes all dependencies on external model providers.
 */
export class AiService {
  engine;
  dimensions;
  constructor(config) {
    this.dimensions = config?.outputDimensionality || DEFAULT_DIMENSIONS;
    this.engine = new LocalEmbeddingEngine(this.dimensions);
    console.log(`[AiService] Initialized native local embedding engine (${this.dimensions} dims).`);
  }
  /** Always returns true as it uses a local hashing engine. */
  isAvailable() {
    return true;
  }
  /**
   * Local fallback for text summarization.
   * Simply returns a truncated version of the text with a notice.
   */
  async summarizeText(text) {
    if (!text.trim()) return text;
    const truncated = text.length > 200 ? text.substring(0, 200) + '...' : text;
    return `[Local Summary] ${truncated}`;
  }
  /**
   * Embed a single text string using local Feature Hashing.
   */
  async embedText(text, _taskType) {
    if (!text.trim()) return null;
    return this.engine.embed(text);
  }
  /**
   * Embed multiple text strings locally.
   */
  async embedBatch(texts, _taskType) {
    return texts.map((t) => {
      if (!t.trim()) return null;
      return this.engine.embed(t);
    });
  }
  /**
   * Local heuristic for logic relationship evaluation.
   * Returns 'neutral' by default as deep logic requires an LLM.
   */
  async evaluateLogicRelationship(_textA, _textB) {
    return 'neutral';
  }
  /**
   * Local fallback for reasoning explanation.
   */
  async explainReasoningChain(conclusion, steps) {
    if (steps.length === 0) return 'No reasoning steps provided.';
    const stepsSummary = steps.map((s, i) => `${i + 1}. [${s.type}] ${s.content}`).join('\n');
    return `[Local Reasoning] Conclusion: ${conclusion}\nSteps:\n${stepsSummary}`;
  }
  /**
   * Local fallback for constitutional auditing.
   * Returns PASSED by default.
   */
  async auditCodeAgainstRule(_path, _code, _ruleContent) {
    return { violated: false };
  }
  /**
   * Local fallback for general text generation.
   */
  async generateText(prompt, _model) {
    return `[Local Response] Echoing prompt: ${prompt.substring(0, 50)}...`;
  }
  getDimensions() {
    return this.dimensions;
  }
  getModel() {
    return 'native-local-hashing';
  }
}
