// ESLint 9 requires a flat config file; @raycast/eslint-config ships one but
// `ray lint` does not register it on its own.
const raycast = require("@raycast/eslint-config");

module.exports = raycast;
