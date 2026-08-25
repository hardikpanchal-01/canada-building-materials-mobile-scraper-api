/**
 * ConcreteGo SOAP API Service
 *
 * Handles authentication and order queries against the ConcreteGo third-party SOAP API.
 * Authentication is a 3-step process: GetPublicKey -> Encrypt Password -> Login.
 * Order queries use ProcessRequestStr with OrderQueryRq XML.
 */

const axios = require('axios');
const { convertXmlKeyToPem, encryptPassword } = require('../utils/encryption');
const { parseXmlResponse } = require('../utils/xmlParser');

const SOAP_TIMEOUT = 30000; // 30 seconds

class ConcreteGoAPI {
  constructor() {
    this.endpoint = process.env.CONCRETEGO_ENDPOINT;
    this.namespace = 'http://api.concretego.com/';
    this.ticketHeader = null;
  }

  /**
   * Step 1: Get public RSA key from ConcreteGo API
   *
   * @returns {Promise<{ticketHeader: string, publicKeyXml: string}>}
   */
  async getPublicKey() {
    const appId = process.env.PUBLIC_KEY_APP_ID;
    const apiKey = process.env.PUBLIC_KEY_API_KEY;

    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetPublicKey xmlns="${this.namespace}">
      <appID>${appId}</appID>
      <apiKey>${apiKey}</apiKey>
    </GetPublicKey>
  </soap:Body>
</soap:Envelope>`;

    const response = await axios.post(this.endpoint, soapEnvelope, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `${this.namespace}GetPublicKey`
      },
      timeout: SOAP_TIMEOUT
    });

    const parsed = parseXmlResponse(response.data);
    const envelope = parsed['soap:Envelope'];

    const ticketHeader = envelope['soap:Header']?.TicketHeader?.ticket;
    const publicKeyXml = envelope['soap:Body']?.GetPublicKeyResponse?.GetPublicKeyResult;

    if (!ticketHeader || !publicKeyXml) {
      throw new Error('GetPublicKey: missing ticketHeader or publicKeyXml in response');
    }

    return { ticketHeader, publicKeyXml };
  }

  /**
   * Step 3: Perform SOAP Login call
   *
   * @param {string} ticketHeader - Ticket from GetPublicKey
   * @param {string} username - ConcreteGo username
   * @param {string} encryptedPassword - RSA-encrypted password (Base64)
   * @param {string} slug - Company slug
   * @returns {Promise<boolean>} True on success
   */
  async performLogin(ticketHeader, username, encryptedPassword, slug) {
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Header>
    <TicketHeader xmlns="${this.namespace}">
      <ticket>${ticketHeader}</ticket>
    </TicketHeader>
  </soap:Header>
  <soap:Body>
    <Login xmlns="${this.namespace}">
      <userName>${username}</userName>
      <password>${encryptedPassword}</password>
      <slug>${slug || ''}</slug>
    </Login>
  </soap:Body>
</soap:Envelope>`;

    const response = await axios.post(this.endpoint, soapEnvelope, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Accept': 'text/xml',
        'SOAPAction': `${this.namespace}Login`
      },
      timeout: SOAP_TIMEOUT
    });

    const parsed = parseXmlResponse(response.data);
    const envelope = parsed['soap:Envelope'];

    // Check for SOAP fault
    const fault = envelope['soap:Body']?.['soap:Fault'];
    if (fault) {
      const faultString = fault.faultstring || fault.faultString || 'Unknown SOAP fault';
      throw new Error(`Login SOAP fault: ${faultString}`);
    }

    const loginResult = envelope['soap:Body']?.LoginResponse?.LoginResult;
    if (String(loginResult) !== 'true') {
      throw new Error('Authentication failed: Login returned false');
    }

    return true;
  }

  /**
   * Full 3-step authentication flow
   *
   * 1. GetPublicKey -> get ticket + RSA key
   * 2. Encrypt password with RSA
   * 3. Login SOAP call -> ticket becomes auth token
   *
   * @param {string} username - ConcreteGo username
   * @param {string} password - Plaintext password
   * @param {string} [slug] - Company slug
   * @returns {Promise<{ticketHeader: string}>}
   */
  async authenticate(username, password, slug = null) {
    // Step 1: Get public key
    const { ticketHeader, publicKeyXml } = await this.getPublicKey();

    // Step 2: Encrypt password
    const publicKeyPem = convertXmlKeyToPem(publicKeyXml);
    const encryptedPwd = encryptPassword(publicKeyPem, password);

    // Step 3: Login
    await this.performLogin(ticketHeader, username, encryptedPwd, slug);

    // Store ticket for subsequent calls
    this.ticketHeader = ticketHeader;

    return { ticketHeader };
  }

  /**
   * Authenticate using environment variable credentials
   *
   * @returns {Promise<{ticketHeader: string}>}
   */
  async loginWithEnvCredentials() {
    const username = process.env.CONCRETEGO_USERNAME;
    const password = process.env.CONCRETEGO_PASSWORD;
    const slug = process.env.CONCRETEGO_SLUG;

    if (!username || !password) {
      throw new Error('CONCRETEGO_USERNAME and CONCRETEGO_PASSWORD must be set');
    }

    return this.authenticate(username, password, slug);
  }

  /**
   * Get a valid ticket header, auto-authenticating if needed
   *
   * @returns {Promise<string>} Valid ticket header
   */
  async getTicketHeader() {
    if (!this.ticketHeader) {
      await this.loginWithEnvCredentials();
    }
    return this.ticketHeader;
  }

  /**
   * Query orders from ConcreteGo API using ProcessRequestStr
   *
   * @param {object} params - Query parameters
   * @param {string} [params.orderCode] - Order code to search
   * @param {string} [params.orderId] - Order ID to search
   * @param {string} [params.fromOrderDate] - Start date (MM/dd/yyyy)
   * @param {string} [params.toOrderDate] - End date (MM/dd/yyyy)
   * @param {string} ticketHeader - Auth ticket
   * @returns {Promise<Array>} Array of parsed order objects
   */
  async queryOrders(params, ticketHeader) {
    const { orderCode, orderId, fromOrderDate, toOrderDate, includeRemovedOrder } = params;

    // Build filter elements
    let filterXml = '';
    if (orderCode) {
      filterXml += `<OrderCode>${orderCode}</OrderCode>`;
    }
    if (orderId) {
      filterXml += `<OrderID>${orderId}</OrderID>`;
    }
    if (fromOrderDate) {
      filterXml += `<FromOrderDate>${fromOrderDate}</FromOrderDate>`;
    }
    if (toOrderDate) {
      filterXml += `<ToOrderDate>${toOrderDate}</ToOrderDate>`;
    }
    if (includeRemovedOrder) {
      filterXml += `<IncludeRemovedOrder>true</IncludeRemovedOrder>`;
    }

    const innerXml = `<WebcreteXML><WebcreteXMLMsgsRq><OrderQueryRq>${filterXml}<IncludeRetElement>PRODUCT</IncludeRetElement><IncludeRetElement>SCHEDULE</IncludeRetElement><IncludeRetElement>ORDERNOTE</IncludeRetElement></OrderQueryRq></WebcreteXMLMsgsRq></WebcreteXML>`;

    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Header>
    <TicketHeader xmlns="${this.namespace}">
      <ticket>${ticketHeader}</ticket>
    </TicketHeader>
  </soap:Header>
  <soap:Body>
    <ProcessRequest xmlns="${this.namespace}">
      <request><![CDATA[${innerXml}]]></request>
    </ProcessRequest>
  </soap:Body>
</soap:Envelope>`;

    let response;
    try {
      response = await axios.post(this.endpoint, soapEnvelope, {
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Accept': 'text/xml',
          'SOAPAction': `${this.namespace}ProcessRequest`
        },
        timeout: SOAP_TIMEOUT
      });
    } catch (err) {
      // Extract SOAP fault from error response body if available
      if (err.response && err.response.data) {
        try {
          const errParsed = parseXmlResponse(err.response.data);
          const faultString = errParsed?.['soap:Envelope']?.['soap:Body']?.['soap:Fault']?.faultstring;
          if (faultString) {
            throw new Error(`ProcessRequest SOAP fault (${err.response.status}): ${faultString}`);
          }
        } catch (parseErr) {
          if (parseErr.message.includes('SOAP fault')) throw parseErr;
        }
      }
      throw err;
    }

    const parsed = parseXmlResponse(response.data);
    const envelope = parsed['soap:Envelope'];

    // Check for SOAP fault
    const fault = envelope['soap:Body']?.['soap:Fault'];
    if (fault) {
      const faultString = fault.faultstring || fault.faultString || 'Unknown SOAP fault';
      throw new Error(`ProcessRequest SOAP fault: ${faultString}`);
    }

    // Extract the inner XML result
    const resultStr = envelope['soap:Body']?.ProcessRequestResponse?.ProcessRequestResult;
    if (!resultStr) {
      return [];
    }

    // Parse the inner XML
    const innerParsed = parseXmlResponse(resultStr);
    const orderRet = innerParsed?.WebcreteXML?.WebcreteXMLMsgsRs?.OrderQueryRs?.OrderRet;

    if (!orderRet) {
      return [];
    }

    // Normalize to array (API returns object for single result)
    return Array.isArray(orderRet) ? orderRet : [orderRet];
  }
}

module.exports = {
  ConcreteGoAPI
};
