// Catch-all for unknown /api routes: JSON 404 for every method.
import { notFound } from '../_lib/errors.js';

export function onRequest() {
  throw notFound('no such API route');
}
