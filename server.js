//'use strict';
const https = require('https');
const http = require('http');
const url = require('url');

const express = require('express');
const bodyParser = require('body-parser');

const app = express();

// Parse raw body for binary/proxy use-cases
app.use(bodyParser.raw({ type: 'application/octet-stream', limit: '2mb' }));
// Also accept common content types so proxy works with forms / json
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
    // If body was already parsed by body-parser, write it; otherwise pipe the stream
    if (req.body && Buffer.isBuffer(req.body) && req.body.length) {
      connector.write(req.body);
      connector.end();
    } else if (req.body && typeof req.body === 'object' && !(req.body instanceof Buffer)) {
      // json / urlencoded already parsed
      const payload =
        req.is('application/json') || req.headers['content-type']?.includes('json')
          ? JSON.stringify(req.body)
          : new URLSearchParams(req.body).toString();
      connector.write(payload);
      connector.end();
    } else if (typeof req.body === 'string' && req.body.length) {
      connector.write(req.body);
      connector.end();
    } else {
      // fallback: try to pipe original stream if still available
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
    return error(clientResponse);
  }
  if (serverResponse.headers['transfer-encoding'] === 'chunked') {
    delete serverResponse.headers['transfer-encoding'];
  }
  clientResponse.writeHead(serverResponse.statusCode, serverResponse.headers);
  serverResponse.pipe(clientResponse, { end: true });
}

function error(res) {
  res.writeHead(400);
  res.end();
}

app.use((req, res) => {
  let target;
  let maindomain;

  // Nếu có header real-url-request → dùng làm target, Host lấy từ domain của URL đó
  const realUrlRequest = req.headers['real-url-request'];
  if (realUrlRequest) {
    target = realUrlRequest;
    try {
      const parsed = url.parse(realUrlRequest);
      maindomain = parsed.host || parsed.hostname;
    } catch (e) {
      maindomain = req.headers['host'];
    }
  } else {
    // Logic cũ: ghép host + path sau khi bỏ prefix function
    let resourceURL = req.url.replace(/\/\.netlify\/functions\/server\/?/gi, '');
    resourceURL = resourceURL.replace(/^\/+/, '');

    maindomain = req.headers['realip'] ? req.headers['realip'] : req.headers['host'];
    target = 'https://' + maindomain + '/' + resourceURL;
  }

  const proxyOptions = url.parse(target);
  proxyOptions.headers = { ...req.headers };
  proxyOptions.headers['Host'] = maindomain;
  proxyOptions.headers['host'] = maindomain;
  proxyOptions.method = req.method;
  proxyOptions.headers['x-request-id'] = Date.now();

  // Xóa header real-url-request để không gửi lên upstream
  delete proxyOptions.headers['real-url-request'];

  // Remove Netlify / CDN specific headers that can break upstream
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
        console.log('Server is up on 3000')
    });
