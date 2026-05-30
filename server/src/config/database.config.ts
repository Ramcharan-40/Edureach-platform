import mongoose from "mongoose";
import dns from "dns";


let cachedConnectionPromise: Promise<typeof mongoose> | null = null;

const connectDB = async (): Promise<void> => {
  const mongoURI = process.env.MONGODB_URI;

  if (!mongoURI) {
    throw new Error("MONGODB_URI is not defined in environment variables");
  }

  // If already connected, return immediately
  if (mongoose.connection.readyState === 1) {
    return;
  }

  // If connection is in progress, await the existing promise
  if (cachedConnectionPromise) {
    await cachedConnectionPromise;
    return;
  }

  // Start connection and cache the promise
  cachedConnectionPromise = (async () => {
    try {
      const conn = await mongoose.connect(mongoURI);
      console.log(`MongoDB Connected: ${conn.connection.host}`);
      console.log(`MongoDB Database Name: ${conn.connection.name}`);
      return conn;
    } catch (error: any) {
      // If it is a DNS querySrv failure, attempt to self-heal by falling back to public DNS servers
      if (error && error.syscall === "querySrv" && error.code === "ECONNREFUSED") {
        console.warn("⚠️ DNS querySrv ECONNREFUSED detected. Node.js DNS resolution may be misconfigured.");
        console.warn("🔄 Retrying connection using public DNS servers (8.8.8.8, 1.1.1.1)...");
        
        try {
          dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);
          const conn = await mongoose.connect(mongoURI);
          console.log(`MongoDB Connected (via public DNS): ${conn.connection.host}`);
          console.log(`MongoDB Database Name: ${conn.connection.name}`);
          return conn;
        } catch (retryError: any) {
          console.error("❌ Failed to connect even after switching to public DNS:", retryError.message || retryError);
          cachedConnectionPromise = null;
          throw retryError;
        }
      }

      if (error instanceof Error) {
        console.error(`❌ Error connecting to MongoDB: ${error.message}`);
      } else {
        console.error(`❌ Error connecting to MongoDB: ${error}`);
      }
      cachedConnectionPromise = null;
      throw error;
    }
  })();

  await cachedConnectionPromise;
};

export default connectDB;