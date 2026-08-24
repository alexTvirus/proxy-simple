//'use strict';
const https = require('https');
const http = require('http');
const url = require('url');

const express = require('express');
const bodyParser = require('body-parser');

const app = express();

// ===== CORS =====
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, real-url-request, realip, *'
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// Parse body
app.use(bodyParser.raw({ type: 'application/octet-stream', limit: '2mb' }));
app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '20mb' }));
app.use(bodyParser.text({ limit: '20mb' }));

function request(opts, callback) {
  const req = (opts.protocol === 'https:' ? https : http).request(opts, callback);
  req.on('error', callback);
  req.on('socket', function (socket) {
    socket.setTimeout(15000);
    socket.on('timeout', function () {
      console.log('timeout');
      req.abort();
    });
  });
  return req;
}

function intervene(options, callback) {
  callback();
}

function proxyRequest(req) {
  return function (options, res) {
    const connector = request(options, proxyResponse.bind(null, res));

    if (req.body && Buffer.isBuffer(req.body) && req.body.length) {
      connector.write(req.body);
      connector.end();
    } else if (req.body && typeof req.body === 'object' && !(req.body instanceof Buffer)) {
      const payload =
        req.is('application/json') ||
        (req.headers['content-type'] && req.headers['content-type'].includes('json'))
          ? JSON.stringify(req.body)
          : new URLSearchParams(req.body).toString();
      connector.write(payload);
      connector.end();
    } else if (typeof req.body === 'string' && req.body.length) {
      connector.write(req.body);
      connector.end();
    } else {
      if (req.pipe) {
        req.pipe(connector, { end: true });
      } else {
        connector.end();
      }
    }
  };
}

function proxyResponse(clientResponse, serverResponse) {
  if (serverResponse instanceof Error) {
    console.error('Proxy upstream error:', serverResponse.message || serverResponse);
    return error(clientResponse, serverResponse);
  }

  if (serverResponse.headers['transfer-encoding'] === 'chunked') {
    delete serverResponse.headers['transfer-encoding'];
  }

  const headers = { ...serverResponse.headers };
  headers['Access-Control-Allow-Origin'] = '*';
  headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD';
  headers['Access-Control-Allow-Headers'] =
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, real-url-request, realip, *';

  clientResponse.writeHead(serverResponse.statusCode, headers);
  serverResponse.pipe(clientResponse, { end: true });
}

function error(res, err) {
  const message = err ? (err.message || String(err)) : 'Proxy error';
  console.error('Returning error to client:', message);

  res.writeHead(502, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers':
      'Origin, X-Requested-With, Content-Type, Accept, Authorization, real-url-request, realip, *',
  });
  res.end(JSON.stringify({ error: 'Proxy failed', message }));
}

app.use((req, res) => {
  const realUrlRequest = req.headers['real-url-request'];

  // Không có real-url-request → trả về message status 200
  if (!realUrlRequest) {
    return res.status(200).send('missing real-url-request');
  }

  let target = realUrlRequest.trim();
  let maindomain;

  try {
    const parsed = url.parse(target);
    maindomain = parsed.host || parsed.hostname;
  } catch (e) {
    maindomain = req.headers['host'];
  }

  console.log('Proxying →', target);
  console.log('Method:', req.method);

  const proxyOptions = url.parse(target);
  proxyOptions.headers = { ...req.headers };
  proxyOptions.headers['Host'] = maindomain;
  proxyOptions.headers['host'] = maindomain;
  proxyOptions.method = req.method;
  proxyOptions.headers['x-request-id'] = Date.now();

  delete proxyOptions.headers['real-url-request'];
  delete proxyOptions.headers['x-country'];
  delete proxyOptions.headers['x-forwarded-for'];
  delete proxyOptions.headers['x-nf-client-connection-ip'];
  delete proxyOptions.headers['x-forwarded-proto'];
  delete proxyOptions.headers['x-forwarded-host'];
  delete proxyOptions.headers['via'];
  delete proxyOptions.headers['cdn-loop'];

  intervene(proxyOptions, proxyRequest(req).bind(null, proxyOptions, res));
});

app.listen(3000, () => {
  console.log('Server is up on 3000');
});
