const path = require('path');

class WhatsappWebAdapter {
  constructor(sessionId, sessionDir, io) {
    this.sessionId = sessionId;
    this.sessionDir = sessionDir;
    this.io = io || null;
    this.client = null;
    this.puppeteerOptions = { headless: true, args: ['--no-sandbox'] };
    this.authStrategy = { clientId: sessionId, dataPath: sessionDir };
  }
  buildClientConfig() {
    return { puppeteer: this.puppeteerOptions, authStrategy: this.authStrategy };
  }
  async start() {
    // Scaffold only: do not launch browser
    return { status: 'not_implemented' };
  }
  async stop() {
    return { status: 'not_implemented' };
  }
}

module.exports = { WhatsappWebAdapter };
