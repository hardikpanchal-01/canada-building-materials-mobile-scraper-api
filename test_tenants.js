const jwt = require('jsonwebtoken');
const https = require('http');

const tenants = [
  { name: 'CBM', host: 'cbm-api.truckast.ai', secret: process.env.JWT_SECRET_CBM },
  { name: 'ConcreteSupply', host: 'concretesupply-api.truckast.ai', secret: process.env.JWT_SECRET_CONCRETESUPPLY },
  { name: 'Delta', host: 'delta-api.truckast.ai', secret: process.env.JWT_SECRET_DELTA },
  { name: 'Dolese', host: 'dolese-api.truckast.ai', secret: process.env.JWT_SECRET_DOLESE },
  { name: 'Hercules', host: 'hercules-api.truckast.ai', secret: process.env.JWT_SECRET_HERCULES },
  { name: 'SWS', host: 'stevensonweir-api.truckast.ai', secret: process.env.JWT_SECRET_SWS },
  { name: 'Sunrise', host: 'sunrise-api.truckast.ai', secret: process.env.JWT_SECRET_SUNRISE },
  { name: 'Superior', host: 'superior-api.truckast.ai', secret: process.env.JWT_SECRET_SUPERIOR },
];

async function fetchJSON(url, headers = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ code: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ code: res.statusCode, body: { raw: data.slice(0,100) } }); }
      });
    });
    req.on('error', () => resolve({ code: 0, body: { error: 'UNREACHABLE' } }));
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: { error: 'TIMEOUT' } }); });
  });
}

(async () => {
  console.log('=== ALL TENANTS — FULL REGRESSION TEST ===\n');
  
  let totalPass = 0, totalFail = 0;
  
  for (const t of tenants) {
    const token = jwt.sign(
      { id: 'test-uuid-1234', email: 'test@test.com', role: 'authenticated', type: 'access' },
      t.secret,
      { expiresIn: '1h', issuer: 'truckast-api', audience: 'truckast-client' }
    );
    const auth = { Authorization: `Bearer ${token}` };
    
    const tests = [
      { name: 'health', url: `http://${t.host}/health`, auth: false, check: d => d.status === 'healthy' },
      { name: 'dashboard', url: `http://${t.host}/api/new-dashboard`, auth: true, check: d => d.success === true },
      { name: 'orders', url: `http://${t.host}/api/orders`, auth: true, check: d => d.success === true },
      { name: 'weather', url: `http://${t.host}/api/weather/all`, auth: true, check: d => d.success === true },
      { name: 'trucks', url: `http://${t.host}/api/trucks`, auth: true, check: d => d.success === true },
      { name: 'tickets', url: `http://${t.host}/api/tickets`, auth: true, check: d => d.success === true },
      { name: 'timezones', url: `http://${t.host}/api/timezones`, auth: false, check: d => d.success === true },
    ];
    
    let pass = 0, fail = 0;
    const results = [];
    
    for (const test of tests) {
      const r = await fetchJSON(test.url, test.auth ? auth : {});
      const ok = r.code >= 200 && r.code < 300 && test.check(r.body);
      if (ok) { pass++; totalPass++; } else { fail++; totalFail++; }
      results.push(`${ok ? 'PASS' : 'FAIL'}(${r.code})`);
    }
    
    console.log(`  ${t.name.padEnd(18)} ${results.map((r, i) => `${tests[i].name}=${r}`).join('  ')}`);
  }
  
  console.log(`\n=== TOTAL: ${totalPass} PASSED, ${totalFail} FAILED / ${totalPass + totalFail} ===`);
})();
