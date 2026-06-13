import express from 'express';
import { requireApiKey } from './src/auth/apiKey.js';

const app = express();
app.get('/admin', requireApiKey, (req, res) => res.json({ ok: true }));
app.listen(3000);
