import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import {
  ChatGoogleGenerativeAI,
  GoogleGenerativeAIEmbeddings,
} from "@langchain/google-genai";
import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { TextLoader } from "@langchain/classic/document_loaders/fs/text";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

// --- MongoDB Native Client (for LangChain vector operations) ---
// ---- __dirname for ESM ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- MongoDB native client ----
let mongoClient: MongoClient | null = null;
let cachedKnowledgeChunks: string[] | null = null;

const getMongoClient = async (): Promise<MongoClient> => {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI || "");
    await mongoClient.connect();
  }
  return mongoClient;
};

// ---- Google GenAI Embeddings ----
// gemini-embedding-001 → default 3072 dimensions (FREE, same API key as Gemini chat)
const getEmbeddings = () => {
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY is not set in .env!");
  }
  return new GoogleGenerativeAIEmbeddings({
    apiKey: process.env.GOOGLE_API_KEY,
    model: "gemini-embedding-001",
  });
};

// ---- MongoDB Atlas Vector Search Store ----
const getVectorStore = async (): Promise<MongoDBAtlasVectorSearch> => {
  const client = await getMongoClient();
  const collection = client.db("edureach_db").collection("knowledge_docs");
  const embeddings = getEmbeddings();
  return new MongoDBAtlasVectorSearch(embeddings, {
    collection: collection as any,
    indexName: "edureach_vector_index",
    textKey: "text",
    embeddingKey: "embedding",
  });
};

const getLocalKnowledgeChunks = async (): Promise<string[]> => {
  if (cachedKnowledgeChunks) {
    return cachedKnowledgeChunks;
  }

  const filePath = path.join(__dirname, "../../knowledge-base/edureach-knowledge.txt");
  const loader = new TextLoader(filePath);
  const docs = await loader.load();

  if (docs.length === 0) {
    cachedKnowledgeChunks = [];
    return cachedKnowledgeChunks;
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const chunks = await splitter.splitDocuments(docs);
  cachedKnowledgeChunks = chunks.map((doc) => doc.pageContent);
  return cachedKnowledgeChunks;
};

const scoreKnowledgeChunk = (question: string, chunk: string): number => {
  const normalizedQuestion = question.toLowerCase();
  const words = normalizedQuestion.match(/[a-z0-9]+/g) ?? [];
  const uniqueWords = [...new Set(words.filter((word) => word.length > 2))];

  let score = 0;
  for (const word of uniqueWords) {
    if (chunk.toLowerCase().includes(word)) {
      score += 1;
    }
  }

  return score;
};

const getLocalContext = async (question: string): Promise<string> => {
  const chunks = await getLocalKnowledgeChunks();
  if (chunks.length === 0) {
    return "";
  }

  const rankedChunks = chunks
    .map((chunk) => ({ chunk, score: scoreKnowledgeChunk(question, chunk) }))
    .sort((first, second) => second.score - first.score)
    .slice(0, 4)
    .map(({ chunk }) => chunk);

  return rankedChunks.join("\n\n");
};

// --- Initialize Knowledge Base ---

// A) INDEXING — runs ONCE at server startup
// ============================================
export const initializeKnowledgeBase = async (): Promise<void> => {
  const client = await getMongoClient();
  const collection = client.db("edureach_db").collection("knowledge_docs");

  // Check if docs exist WITH valid (non-empty) embeddings
  const docWithEmbedding = await collection.findOne({
    embedding: { $exists: true, $not: { $size: 0 } },
  });

  if (docWithEmbedding) {
    const count = await collection.countDocuments();
    console.log(` Knowledge base ready (${count} chunks with embeddings)`);
    return;
  }

  // If docs exist but embeddings are empty → delete and re-index
  const existingCount = await collection.countDocuments();
  if (existingCount > 0) {
    console.log(` Found ${existingCount} chunks with EMPTY embeddings — deleting & re-indexing...`);
    await collection.deleteMany({});
  }

  console.log(" Indexing knowledge base...");

  // Verify API key FIRST with a test embedding
  const embeddings = getEmbeddings();
  try {
    const testResult = await embeddings.embedQuery("test");
    console.log(` API key OK — embedding dimensions: ${testResult.length}`);
  } catch (error: any) {
    console.error(" Embedding test failed!");
    console.error("   Error:", error.message || error);
    console.error("   Get key from: https://aistudio.google.com/apikey");
    throw error;
  }

  // LOAD
  const filePath = path.join(__dirname, "../../knowledge-base/edureach-knowledge.txt");
  const loader = new TextLoader(filePath);
  const docs = await loader.load();
  if (docs.length === 0) {
    throw new Error("No documents found in knowledge base file");
  }
  const totalCharacters = docs.reduce((sum, doc) => sum + doc.pageContent.length, 0);
  console.log(`    Loaded ${totalCharacters} characters`);

  // SPLIT
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const allSplits = await splitter.splitDocuments(docs);
  console.log(`    Split into ${allSplits.length} chunks`);

  // EMBED + STORE
  const vectorStore = new MongoDBAtlasVectorSearch(embeddings, {
    collection: collection as any,
    indexName: "edureach_vector_index",
    textKey: "text",
    embeddingKey: "embedding",
  });

  await vectorStore.addDocuments(allSplits);

  // VERIFY
  const verifyDoc = await collection.findOne({
    embedding: { $exists: true, $not: { $size: 0 } },
  });

  if (verifyDoc && Array.isArray(verifyDoc.embedding) && verifyDoc.embedding.length > 0) {
    console.log(`    ${allSplits.length} chunks stored (${verifyDoc.embedding.length}D embeddings)`);
    console.log(`     IMPORTANT: Create Atlas Vector Search index with numDimensions: ${verifyDoc.embedding.length}`);
  } else {
    await collection.deleteMany({});
    throw new Error(" Embeddings are empty! Google API returned no vectors.");
  }
};

let isRAGInitialized = false;
let initializingPromise: Promise<void> | null = null;

export const ensureRAGInitialized = async (): Promise<void> => {
  if (isRAGInitialized) return;
  if (initializingPromise) {
    return initializingPromise;
  }

  initializingPromise = (async () => {
    try {
      await initializeKnowledgeBase();
      isRAGInitialized = true;
    } finally {
      initializingPromise = null;
    }
  })();

  return initializingPromise;
};

// --- Get RAG Response ---
export const getRAGResponse = async (question: string): Promise<string> => {
  try {
    await ensureRAGInitialized();
    let context = "";

    try {
      const vectorStore = await getVectorStore();
      const retrievedDocs = await vectorStore.similaritySearch(question, 5);

      if (retrievedDocs.length > 0) {
        context = retrievedDocs
          .map((doc) => `Source: ${doc.metadata.source ?? "knowledge-base"}\nContent: ${doc.pageContent}`)
          .join("\n\n");
      }
    } catch (error) {
      console.warn(" Vector search unavailable, using local knowledge base fallback.", error);
    }

    if (!context) {
      context = await getLocalContext(question);
    }

    if (!context) {
      return "I don't have that information right now. Click Talk to Us to speak with a counselor.";
    }

    const model = new ChatGoogleGenerativeAI({
      model: "gemini-2.5-flash",
      temperature: 0.0,
    });

    const prompt = [
      "You are EduReach Bot, a helpful AI counselor for EduReach College, Hyderabad.",
      "Answer only using the provided knowledge base context.",
      "Do not invent facts or use outside knowledge.",
      "If the context does not contain the answer, reply exactly:",
      "I don't have that information right now. Click Talk to Us to speak with a counselor.",
      "",
      `Knowledge base context:\n${context}`,
      "",
      `User question: ${question}`,
    ].join("\n");

    const result = await model.invoke(prompt);

    return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  } catch (error) {
    console.error(" RAG Agent Error:", error);
    return "I'm having trouble right now. Please try again or click 'Talk to Us'.";
  }
};