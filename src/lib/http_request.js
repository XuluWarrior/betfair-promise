// (C) 2016 Anton Zemlyanov, rewritten in JavaScript 6 (ES6)
'use strict';

const usingBrowserHttp = typeof window !== 'undefined' && !window.process /* In Node.js/electron */;
const useCordovaHttp = usingBrowserHttp && window.cordovaHTTP;
//var Stream = require('stream');

function fromQueryString(queryString) {
    const parts = queryString.split("&");
    const queries = {};
    parts.forEach((part) => {
        const [key,value] = part.split("=");
        queries[decodeURIComponent(key)] = decodeURIComponent(value);
    });
    return queries;
}

function CordovaResponse(res) {
    this.res = res;
    this.statusCode = res.status;
    this.headers = {};
    Object.keys(res.headers).forEach((key) => {
        this.headers[key.toLowerCase()] = res.headers[key];
    });
    this.dataCallback = null;

    this.on = function(event, callback) {
        switch (event) {
            case "data":
                this.dataCallback = callback;
                break;
            case "error":
                // It's too late for an error.  Ignore
        }
    };

    this.pipe = function(out) {
        this.dataCallback && this.dataCallback(this.res.data);
        const stream = new Stream();
        stream.readable = true;
        stream.pipe(out);
        stream.emit("data", this.res.data);
        stream.emit("end");

    }
}
const CordovaRequest = function(protocol, httpOptions, callback) {

    this.protocol = protocol;
    this.defaultPort = protocol === "http" ? 80 : 443;
    this.httpOptions = httpOptions;
    this.resultCallback = (res) => {
        const result = new CordovaResponse(res);
        callback(result);
    };
    this.errorCallback = null;
    this.queryData = {};

    this.on = function(event, callback) {
        switch (event) {
            case "error":
                this.errorCallback = (error) => {
                    debugger;
                    callback(error);
                }
        }
    };

    this.setTimeout = function() {

    };

    this.write = function(data) {
        this.queryData = data; // fromQueryString(data);
    };

    this.end = function() {
        const url = this.protocol + "://" + this.httpOptions.host + ":" + (this.httpOptions.port || this.defaultPort) + this.httpOptions.path;

        const headers = Object.assign({}, this.httpOptions.headers);
        delete headers["content-length"];
        delete headers["Content-Length"];
        cordovaHTTP[this.httpOptions.method](
            url,
            this.queryData,
            headers,
            this.resultCallback,
            this.errorCallback
        );
    }
};

const CordovaHTTPAgent = function(protocol) {
    this.protocol = protocol;



    this.request = function(httpOptions, callback) {
        return new CordovaRequest(this.protocol, httpOptions, callback);
    }
};

const http = useCordovaHttp ? new CordovaHTTPAgent("http") : require('http');
const https = useCordovaHttp ? new CordovaHTTPAgent("https") : require('https');
const url = require('url');
const zlib = require('zlib');
const Stream = require('stream');
const _ = require('lodash');
const hrtime = require('browser-process-hrtime');

const cookieJar = require('./cookie_jar.js');

// always used with BF API
const USE_GZIP_COMPRESSION = true;
const NANOSECONDS_IN_SECOND = 1000000000;
const MAX_REQUEST_TIMEOUT = 15*1000;

const agentParams = {keepAlive: true, maxFreeSockets: 8};
const httpAgent = useCordovaHttp ? agentParams : new http.Agent(agentParams);
const httpsAgent = useCordovaHttp ? agentParams : new https.Agent(agentParams);

class HttpRequest extends Stream {
    // get http request
    static get(url, options = {}, cb = () => {}) {
        const opts = _.extend({
            url: url,
            method: 'get'
        }, options);
        return new HttpRequest(opts).execute(cb);
    }

    // post http request
    static post(url, data, options = {}, cb = () => {}) {
        const opts = _.extend({
            url: url,
            method: 'post',
            requestBody: data
        }, options);
        return new HttpRequest(opts).execute(cb);
    }

    // constructor
    constructor(options = {}) {
        super();

        // Stream stuff, HttpRequest is writable stream
        this.readable = false;
        this.writable = true;

        this.options = options;
        this.rawResponseLength = 0;
        this.responseBody = '';
        this.parsedUrl = url.parse(options.url);
        this.method = options.method;
    }

    // do actual job
    execute(cb = () => {
    }) {
        this.callback = cb;
        const transport = this.parsedUrl.protocol === 'https:' ? https : http;
        let httpOptions = {
            agent: (this.parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent),
            host: this.parsedUrl.hostname,
            port: this.parsedUrl.port,
            path: this.parsedUrl.pathname,
            method: this.method,
            headers: this.options.headers || {},
            rejectUnauthorized: false
        };
        _.extend(httpOptions.headers, this.options.headers);
        httpOptions.headers.cookie = cookieJar.serialize();
        if (USE_GZIP_COMPRESSION) {
            httpOptions.headers['accept-encoding'] = 'gzip';
        }
        httpOptions.headers.cookie = cookieJar.serialize();

        let request = transport.request(httpOptions, (result) => {
            //console.log("statusCode: ", result.statusCode, "headers: ", result.headers);
            this.statusCode = result.statusCode;
            this.statusMessage = result.statusMessage;
            this.contentType = result.headers['content-type'];
            this.cookies = result.headers['set-cookie'];
            cookieJar.parse(this.cookies);

            // just for stats
            result.on('data', (data) => {
                this.rawResponseLength += data.length;
            });
            result.on('error', (err) => {
                this.callback(err);
            });

            // http request input to self output
            if (!usingBrowserHttp && result.headers['content-encoding'] === 'gzip') {
                // piping through gzip
                let gunzip = zlib.createGunzip();
                result.pipe(gunzip).pipe(this);
            } else {
                // piping directly to self
                result.pipe(this);
            }
        });
        request.on('error', (err) => {
            this.callback(err);
        });
        // request.on('socket', function (socket) {
        //     socket.setTimeout(MAX_REQUEST_TIMEOUT);
        //     socket.on('timeout', function() {
        //         request.abort();
        //     });
        // });
        request.setTimeout(MAX_REQUEST_TIMEOUT, () => {
            request.abort();
            //this.callback('REQUEST_TIMEOUT');
        });
        if (this.method === 'post') {
            request.write(this.options.requestBody);
        }
        this.startTime = hrtime();
        request.end();
    }

    // http(s) chuck data
    write(data) {
        this.responseBody += data.toString();
    }

    // http(s) end of chunk data
    end() {
        // duration
        this.endTime = hrtime();
        let start = this.startTime[0] + (this.startTime[1] / NANOSECONDS_IN_SECOND);
        let end = this.endTime[0] + (this.endTime[1] / NANOSECONDS_IN_SECOND);

        // gzip compression efficiency
        let responseBodyLength = this.responseBody.length;
        let ratio = 100.0 - (this.rawResponseLength / responseBodyLength) * 100.0;
        ratio = Math.round(ratio);

        // if JSON, parse JSON into JS object
        if (this.contentType === 'application/json') {
            try {
                this.responseBody = JSON.parse(this.responseBody);
            } catch (error) {
                this.responseBody = {
                    error: 'Bad JSON'
                };
            }
        }

        this.callback(null, {
            statusCode: this.statusCode,
            statusMessage: this.statusMessage,
            contentType: this.contentType,
            responseBody: this.responseBody,
            cookies: this.cookies,
            length: responseBodyLength,
            compressionRation: ratio,
            duration: Math.round((end - start) * 1000)
        });
    }
}
module.exports = HttpRequest;
