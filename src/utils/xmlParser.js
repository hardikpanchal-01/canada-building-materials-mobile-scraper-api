/**
 * XML Parser Utility
 *
 * Wrapper around fast-xml-parser for parsing SOAP XML responses.
 */

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: false,
  parseTagValue: true,
  trimValues: true
});

/**
 * Parse an XML string into a JavaScript object
 *
 * @param {string} xmlString - XML string to parse
 * @returns {object} Parsed JavaScript object
 */
function parseXmlResponse(xmlString) {
  if (!xmlString) {
    throw new Error('XML string is required');
  }
  return parser.parse(xmlString);
}

module.exports = {
  parseXmlResponse
};
