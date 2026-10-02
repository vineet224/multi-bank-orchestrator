import app from './app.js';
import { config } from './config/index.js';

const server = app.listen(config.port, () => {
  console.log(`=========================================`);
  console.log(`🚀 ${config.appName} started`);
  console.log(`📡 Environment: ${config.env}`);
  console.log(`🔗 Local URL:   http://localhost:${config.port}`);
  console.log(`💾 Storage:     In-Memory Hashtables (Map)`);
  console.log(`=========================================`);
});

// Graceful shutdown
const handleShutdown = (signal) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
