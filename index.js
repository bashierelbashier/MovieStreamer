import { createMovieStreamer } from './server.js';

const port = Number(process.env.PORT) || 3000;
const app = createMovieStreamer();

app.listen(port).then((p) => {
  console.log(`\nMovieStreamer → http://localhost:${p}`);
  console.log(`  Watch:          GET  http://localhost:${p}/watch`);
  console.log(`  Start stream:   GET  http://localhost:${p}/start-streaming`);
  console.log(`  Health:         GET  http://localhost:${p}/health\n`);
}).catch((err) => {
  console.error('Failed to start MovieStreamer:', err);
  process.exit(1);
});
