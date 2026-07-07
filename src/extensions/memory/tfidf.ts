/**
 * TF-IDF vector engine — pure TypeScript, zero dependencies.
 *
 * Provides semantic similarity without numpy or embeddings.
 * Sparse vector representation stored as JSON for SQLite TEXT column.
 *
 * TF(t,d) = count(t in d) / len(d)
 * IDF(t)  = log(N / df(t))   where df(t) = number of docs containing t
 * TF-IDF  = TF * IDF
 */

/** Simple whitespace tokenization with lowercasing and punctuation strip. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[.,;:!?"'()[\]{}#@<>]+|[.,;:!?"'()[\]{}#@<>]+$/g, ""))
    .filter((w) => w.length > 1);
}

/** Stopwords dropped before vector computation. */
const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "all", "am", "an", "and",
  "any", "are", "as", "at", "be", "because", "been", "before", "being",
  "between", "both", "but", "by", "can", "could", "did", "do", "does",
  "doing", "don", "down", "during", "each", "few", "for", "from",
  "further", "had", "has", "have", "having", "he", "her", "here",
  "hers", "herself", "him", "himself", "his", "how", "i", "if", "in",
  "into", "is", "it", "its", "itself", "just", "me", "more", "most",
  "my", "myself", "no", "nor", "not", "now", "of", "off", "on", "once",
  "only", "or", "other", "our", "ours", "ourselves", "out", "over",
  "own", "same", "she", "should", "so", "some", "such", "than", "that",
  "the", "their", "theirs", "them", "themselves", "then", "there",
  "these", "they", "this", "those", "through", "to", "too", "under",
  "until", "up", "very", "was", "we", "were", "what", "when", "where",
  "which", "while", "who", "whom", "why", "will", "with", "would",
  "you", "your", "yours", "yourself", "yourselves",
]);

/** Filter out stopwords from a token list. */
export function filterStopwords(tokens: string[]): string[] {
  return tokens.filter((t) => !STOPWORDS.has(t));
}

/** Sparse vector: map of term -> weight. */
export type SparseVector = Record<string, number>;

/** Build IDF map from a corpus of pre-tokenized documents. */
export function buildIdfMap(corpus: string[][]): Map<string, number> {
  const n = corpus.length;
  if (n === 0) return new Map();

  const df = new Map<string, number>();
  for (const doc of corpus) {
    const unique = new Set(doc);
    for (const term of unique) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    // Standard IDF with smoothing
    idf.set(term, Math.log((n + 1) / (count + 1)) + 1);
  }
  return idf;
}

/** Compute TF-IDF sparse vector for a tokenized document. */
export function computeTfIdf(tokens: string[], idf: Map<string, number>): SparseVector {
  if (tokens.length === 0) return {};

  // Count term frequencies
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  const vec: SparseVector = {};
  for (const [term, count] of tf) {
    const idfWeight = idf.get(term) ?? 1.0;
    vec[term] = (count / tokens.length) * idfWeight;
  }
  return vec;
}

/** Cosine similarity between two sparse vectors. */
export function cosineSimilarity(a: SparseVector, b: SparseVector): number {
  // Compute magnitudes
  let magA = 0;
  for (const k in a) { const v = a[k]!; magA += v * v; }
  if (magA === 0) return 0;

  let magB = 0;
  for (const k in b) { const v = b[k]!; magB += v * v; }
  if (magB === 0) return 0;

  // Dot product — iterate over the smaller map
  let dot = 0;
  const [iter, lookup] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
  for (const k in iter) {
    const v = lookup[k];
    if (v !== undefined) dot += iter[k]! * v;
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Serialize sparse vector to JSON string for storage. */
export function vectorToJson(vec: SparseVector): string {
  return JSON.stringify(vec);
}

/** Deserialize sparse vector from JSON string. */
export function vectorFromJson(json: string): SparseVector {
  try {
    return JSON.parse(json) as SparseVector;
  } catch {
    return {};
  }
}
