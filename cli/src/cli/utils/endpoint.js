const api = require("../api/client");

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m"
};

/**
 * Get endpoint URL based on tunnel status
 * @param {number} port - Local server port
 * @returns {Promise<{endpoint: string, tunnelEnabled: boolean}>}
 */
async function getEndpoint(port) {
  // Tunnel product removed — always local
  const endpoint = `http://localhost:${port}/v1`;
  return { endpoint, tunnelEnabled: false };
}

/**
 * Get endpoint with color formatting
 * @param {number} port - Local server port
 * @returns {Promise<string>} Colored endpoint string
 */
async function getEndpointColored(port) {
  const { endpoint, tunnelEnabled } = await getEndpoint(port);
  return tunnelEnabled ? `${COLORS.green}${endpoint}${COLORS.reset}` : endpoint;
}

module.exports = { getEndpoint, getEndpointColored };
