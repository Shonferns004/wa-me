function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  const expected = process.env.API_KEY;
  if (!expected || key !== expected) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
}

module.exports = { apiKeyAuth };
