/*
 * Copyright (c) 2015 Adobe Systems Incorporated. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var _fs = require("fs");
var net = require("net");
var http = require("http");
var https = require("https");
var URL = require("url");
var PATH = require("path");
var mime = require("mime");
var heuristic = require("./heuristic");

exports = module.exports = serverReplay;
function serverReplay(har, options) {
    var fs = options.fs || _fs;
    if (!options.ssl) {
        options.ssl = {
            key: PATH.join(__dirname, "ssl", "snakeoil.key"),
            cert: PATH.join(__dirname, "ssl", "snakeoil.crt")
        };
    }

    if (!options.httpPort) {
        options.httpPort = 0;
    }

    if (!options.httpsPort) {
        options.httpsPort = 0;
    }

    options.ssl.key = fs.readFileSync(options.ssl.key);
    options.ssl.cert = fs.readFileSync(options.ssl.cert);

    var requestListener = makeRequestListener(har.log.entries, options);
    var httpServer = http.createServer(requestListener);
    var httpsServer = https.createServer(options.ssl, requestListener);
    var proxyStarted = false;

    httpServer.listen(options.httpPort);
    httpsServer.listen(options.httpsPort);

    httpServer.once("listening", function () {
        options.httpPort = httpServer.address().port;
        if (options.httpPort && options.httpsPort && !proxyStarted) {
            startProxy(options);
            proxyStarted = true;
        }
    });

    httpsServer.once("listening", function () {
        options.httpsPort = httpsServer.address().port;
        if (options.httpPort && options.httpsPort && !proxyStarted) {
            startProxy(options);
            proxyStarted = true;
        }
    });
}

function startProxy(options) {
    var internalProxy = net.createServer(chooseProtocol.bind(this, options));
    internalProxy.listen(options.port);
}

function chooseProtocol(options, connection) {
    connection.on("error", handleProxyError);
    connection.once("data", function (buf) {
        var intent = buf.toString().split("\r\n")[0];
        var destPort = options.httpPort;

        if (/^CONNECT .+?:443 HTTP\/\d(?:\.\d)?$/.test(intent)) {
            destPort = options.httpsPort;
            connection.write(
                "HTTP/1.1 200 Connection established\r\n" +
                "Connection: keep-alive\r\n" +
                "Via: HTTP/1.1 server-replay\r\n" +
                "\r\n"
            );

            connection.once("data", function (buf2) {
                bridgeConnection(buf2, connection, destPort);
            });
        } else {
            bridgeConnection(buf, connection, destPort);
        }
    });
}

function handleProxyError(err) {
    console.warn("An error occurred while proxying:");
    console.warn(err.stack);
}

function bridgeConnection(buf, connection, destPort) {
    var proxy = net.createConnection(destPort, function () {
        proxy.write(buf);
        connection.pipe(proxy).pipe(connection);
    });
}

// Export for testing
exports.makeRequestListener = makeRequestListener;
function makeRequestListener(entries, options) {
    var config = options.config;
    var resolvePath = options.resolvePath;
    var debug = options.debug;
    // for mocking
    var fs = options.fs || _fs;

    return function (request, response) {
        if (debug) {
            console.log(request.method, request.url);
        }
        request.parsedUrl = URL.parse(request.url, true);

        var entry = heuristic(entries, request);

        var localPath;
        for (var i = 0; i < config.mappings.length; i++) {
            if ((localPath = config.mappings[i](request.url))) {
                localPath = PATH.resolve(resolvePath, localPath);
                break;
            }
        }

        if (localPath) {
            // If there's local content, but no entry in the HAR, create a shim
            // entry so that we can still serve the file
            if (!entry) {
                var mimeType = mime.lookup(localPath);
                entry = {
                    response: {
                        status: 200,
                        headers: [{
                            name: 'Content-Type',
                            value: mimeType
                        }],
                        content: {
                            mimeType: mimeType
                        }
                    }
                };
            }

            // If we have a file location, then try and read it. If that fails, then
            // return a 404
            fs.readFile(localPath, function (err, content) {
                if (err) {
                    console.error("Error: Could not read", localPath, "requested from", request.url);
                    serveError(request.url, response, null, localPath);
                    return;
                }

                entry.response.content.buffer = content;
                serveEntry(request, response, entry, config);
            });
        } else {
            if (!serveError(request.url, response, entry && entry.response)) {
                serveEntry(request, response, entry, config);
            }
        }

    };
}

function serveError(requestUrl, response, entryResponse, localPath) {
    if (!entryResponse) {
        console.log("Not found:", requestUrl);
        response.writeHead(404, "Not found", {"content-type": "text/plain"});
        response.end("404 Not found" + (localPath ? ", while looking for " + localPath : ""));
        return true;
    }

    // A resource can be blocked by the client recording the HAR file. Chrome
    // adds an `_error` string property to the response object. Also try
    // detecting missing status for other generators.
    if (entryResponse._error || !entryResponse.status) {
        var error = entryResponse._error ? JSON.stringify(entryResponse._error) : "Missing status";
        response.writeHead(410, error, {"content-type": "text/plain"});
        response.end(
            "HAR response error: " + error +
            "\n\nThis resource might have been blocked by the client recording the HAR file. For example, by the AdBlock or Ghostery extensions."
        );
        return true;
    }

    return false;
}

function serveHeaders(response, entryResponse) {
    // Not really a header, but...
    response.statusCode = (entryResponse.status === 304) ? 200 : entryResponse.status;

    for (var h = 0; h < entryResponse.headers.length; h++) {
        var name = entryResponse.headers[h].name;
        var value = entryResponse.headers[h].value;

        if (name.toLowerCase() === "content-length") continue;
        if (name.toLowerCase() === "content-encoding") continue;
        if (name.toLowerCase() === "cache-control") continue;
        if (name.toLowerCase() === "pragma") continue;

        var existing = response.getHeader(name);
        if (existing) {
            if (Array.isArray(existing)) {
                response.setHeader(name, existing.concat(value));
            } else {
                response.setHeader(name, [existing, value]);
            }
        } else {
            response.setHeader(name, value);
        }
    }

    // Try to make sure nothing is cached
    response.setHeader("cache-control", "no-cache, no-store, must-revalidate");
    response.setHeader("pragma", "no-cache");
}

function manipulateContent(request, entry, replacements) {
    var entryResponse = entry.response;
    var content;
    if (isBinary(entryResponse)) {
        content = entryResponse.content.buffer;
    } else {
        content = entryResponse.content.buffer.toString("utf8");
        var context = {
            request: request,
            entry: entry
        };
        replacements.forEach(function (replacement) {
            content = replacement(content, context);
        });
    }

    if (entryResponse.content.size > 0 && !content) {
        console.error("Error:", entry.request.url, "has a non-zero size, but there is no content in the HAR file");
    }

    return content;
}

function isBase64Encoded(entryResponse) {
    if (!entryResponse.content.text) {
        return false;
    }
    var base64Size = entryResponse.content.size / 0.75;
    var contentSize = entryResponse.content.text.length;
    return contentSize && contentSize >= base64Size && contentSize <= base64Size + 4;
}

// FIXME
function isBinary(entryResponse) {
    return /^image\/|application\/octet-stream/.test(entryResponse.content.mimeType);
}

function serveEntry(request, response, entry, config) {
    var entryResponse = entry.response;
    serveHeaders(response, entryResponse);

    if (!entryResponse.content.buffer) {
        if (isBase64Encoded(entryResponse)) {
            entryResponse.content.buffer = new Buffer(entryResponse.content.text || "", 'base64');
        } else {
            entryResponse.content.buffer = new Buffer(entryResponse.content.text || "", 'utf8');
        }
    }

    response.end(manipulateContent(request, entry, config.replacements));
}
