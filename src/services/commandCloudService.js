/**
 * Command Cloud API Service
 *
 * Handles authentication and order queries against the Command Cloud (CommandAlkon) REST API.
 * Adapted from the stevensonweir-cron-truckast project's authService + orderService.
 *
 * Auth flow: login → refresh_token → access_token (auto-refreshes before expiry)
 */

const axios = require('axios');

const TIMEOUT = parseInt(process.env.COMMANDCLOUD_TIMEOUT) || 30000;

class CommandCloudAPI {
  constructor() {
    this.authUrl = process.env.COMMANDCLOUD_AUTH_URL;
    this.dispatchUrl = process.env.COMMANDCLOUD_DISPATCH_URL;
    this.entityRef = process.env.COMMANDCLOUD_ENTITY_REF;
    this.clientId = process.env.COMMANDCLOUD_CLIENT_ID;
    this.clientSecret = process.env.COMMANDCLOUD_CLIENT_SECRET;
    this.apiScopeRef = process.env.COMMANDCLOUD_API_SCOPE_REF;
    this.apiKey = process.env.COMMANDCLOUD_API_KEY;

    this.refreshToken = null;
    this.accessToken = null;
    this.tokenExpiry = null;
    this.expiryBufferMs = 5 * 60 * 1000; // refresh 5 min before expiry
  }

  /**
   * Login to Command Cloud → get refresh_token, then immediately get access_token
   */
  async login() {
    const url = `${this.authUrl}/${this.entityRef}/api/login`;

    const response = await axios.post(
      url,
      {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        apiScopeRef: this.apiScopeRef,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-api-key': this.apiKey,
        },
        timeout: TIMEOUT,
      }
    );

    this.refreshToken = response.data.refresh_token;
    await this.refreshAccessToken();
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token. Call login() first.');
    }

    const url = `${this.authUrl}/${this.entityRef}/api/tokens/refresh-access-token`;

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${this.refreshToken}`,
        'Accept': 'application/json',
        'x-api-key': this.apiKey,
      },
      timeout: TIMEOUT,
    });

    this.accessToken = response.data.access_token;
    const expiresIn = response.data.expires_in || 3600;
    this.tokenExpiry = Date.now() + (expiresIn * 1000);
  }

  /**
   * Ensure authenticated — login or refresh as needed
   */
  async ensureAuthenticated() {
    if (!this.refreshToken) {
      await this.login();
      return;
    }
    if (!this.accessToken || !this.tokenExpiry || Date.now() >= (this.tokenExpiry - this.expiryBufferMs)) {
      await this.refreshAccessToken();
    }
  }

  /**
   * Get auth headers for API calls
   */
  async getAuthHeaders() {
    await this.ensureAuthenticated();
    return {
      'x-api-key': this.apiKey,
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  /**
   * Fetch orders from Command Cloud API with pagination
   *
   * @param {object} options
   * @param {string} [options.dateOption] - e.g. 'Last_24_Hours'
   * @param {string} [options.startDate] - ISO 8601 start date
   * @param {string} [options.endDate] - ISO 8601 end date
   * @param {string} [options.dateField] - 'modifyDate' or 'startDateTime'
   * @param {number} [options.limit] - Max records per page (default 1000)
   * @returns {Promise<Array>} Array of order objects
   */
  async listOrders(options = {}) {
    const {
      dateOption = process.env.DEFAULT_DATE_OPTION || 'Last_24_Hours',
      startDate,
      endDate,
      dateField = 'startDateTime',
      limit = 1000,
    } = options;

    const url = `${this.dispatchUrl}/${this.entityRef}/orders`;
    const headers = await this.getAuthHeaders();

    const params = {
      dateOption,
      dateField,
      limit,
      format: 'pagination',
      expand: 'deliverySchedule,deliveryScheduleQuantities,tickets',
    };

    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;

    const allOrders = [];
    let pageToken = null;
    let pageCount = 0;

    do {
      pageCount++;
      if (pageToken) params.pageToken = pageToken;

      const response = await axios.get(url, {
        headers,
        params,
        timeout: TIMEOUT,
      });

      const data = response.data;

      if (data.items && Array.isArray(data.items)) {
        allOrders.push(...data.items);
        pageToken = data.pageToken || null;
      } else if (Array.isArray(data)) {
        allOrders.push(...data);
        pageToken = null;
      } else {
        pageToken = null;
      }

      if (pageCount > 100) break; // safety limit
    } while (pageToken);

    return allOrders;
  }

  /**
   * Fetch a single order by orderRef
   *
   * @param {string} orderRef - Order reference GUID
   * @returns {Promise<object>} Order object
   */
  async getOrder(orderRef) {
    const url = `${this.dispatchUrl}/${this.entityRef}/orders/${orderRef}`;
    const headers = await this.getAuthHeaders();

    const response = await axios.get(url, {
      headers,
      params: {
        expand: 'deliverySchedule,deliveryScheduleQuantities,tickets',
      },
      timeout: TIMEOUT,
    });

    return response.data;
  }
}

module.exports = { CommandCloudAPI };
