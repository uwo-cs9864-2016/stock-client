'use strict';

const assert = require('assert');
const url = require('url');
const util = require('util');
const os = require('os');
const zlib = require('zlib');

const moment = require('moment');
const request = require('request');
const _ = require('lodash');

const express = require('express');
const bodyParser = require('body-parser');
const compression = require('compression');

module.exports = (winston) => {

  const w = (!!winston ? winston : require('winston'));
  if (!!process.env['LOG_LEVEL']) {
    w.level = process.env['LOG_LEVEL'];
  }

  /**
   * Specialized class that handles memoizing a compressed payload
   */
  class Data {

    /**
     * Accepts the JSON format passed by the stock server.
     * @param {{when: String, tickers: String[], payload: String}} json JSON data from Stock Server
     */
    constructor(json) {

      this._when = moment(json.when);
      this._tickers = json.tickers.map(_.upperCase);

      this._payload = {
        buff: new Buffer(json.payload, 'base64'),
        decoded: undefined
      };
    }

    get when() { return this._when; }
    get tickers() { return this._tickers; }

    /**
     * Get the payload of the data, it will decoded it if necessary. This method memoizes the value so it is only
     * decoded once.
     *
     * @param {function} next Callback passed an error if any
     */
    payload(next) {
      if (!!this._payload.buff) {
        zlib.gunzip(this._payload.buff, (err, buff) => {
          if (!!err) {
            if (_.isFunction(next)) {
              next(err);
            } else {
              throw err;
            }
          } else {
            const jsonStr = buff.toString('ascii');
            this._payload.decoded = JSON.parse(jsonStr);

            delete this._payload.buff;

            if (_.isFunction(next)) {
              next(null, this._payload.decoded);
            }
          }
        });
      } else if (!!this._payload.decoded) {
        if (_.isFunction(next)) {
          next(null, this._payload.decoded);
        }
      } else {
        let err = new TypeError('No payload buffer or decoded value?');
        if (_.isFunction(next)) {
          next(err);
        } else {
          throw err;
        }
      }
    }
  }

  class Client {

    /**
     * Handler for errors
     * @callback ErrorCallback
     * @param {express~Response} Express response object
     * @param {Error} err
     */

    /**
     * Status handler that gets status as a string and the information around sending.
     * @callback StatusCallback
     * @param {String} status Message
     * @param {express~Request} Sender information
     */

    /**
     * Handler when data is received, it gets a buffer of uncompressed data.
     * @callback DataCallback
     *
     * @param {Data} data Data from the streaming service
     * @param {express~Request} req Information about original data buffer
     */

    /**
     * Create a new client within the express app, `config.app`.
     *
     * @param {express} config.app Parent express application
     * @param {cfenv~AppEnv} [config.config] Base for all routes for subapp to be installed, slash terminated
     *
     * @param {String} config.locals.local.pathname Pathname the stock client is registered into.
     * @param {String} [config.locals.remote.secret] Secret token used for server commands, if not specified, server commands will error
     * @param {Number} [config.locals.remote.timeout=15000] Milliseconds to wait between requests
     *
     * @param {ErrorCallback} [config.handlers.error]
     * @param {StatusCallback} [config.handlers.status]
     * @param {DataCallback} [config.handlers.data]
     */
    constructor(config) {

      assert(!!config.app);

      config = _.defaultsDeep(config, {
        handlers: {
          error: (resp, err) => {
            if (!!err) {
              w.error(err.toString());
            }
          },

          status: (status, req) => {
            w.debug('[%s]: SIGNAL: %s\n',
              req.ip, status);
          },

          data: (data, req) => {
            data.payload((err, payload) => {
              w.debug('[%s]: Received %d rows\n',
                req.ip, payload.length);
            });
          }
        }
      });

      this._config = config.config;

      this._servUrl = url.parse(this._config.getServiceURL("stock-server").slice(0, -1));
      this._pathname = _.get(config.config, "locals.local.client.pathname");

      if (!this._config.isLocal) {
        this._local = url.parse(this._config.url);
      } else {
        this._local = {
          protocol: "http:",
          port: this._config.port
        };
      }

      this._local = _.extend(this._local, {
        pathname: this._pathname
      });

      this._secret = this._config.locals.remote.secret;

      /**
       * How long to wait before timing out with requests (milliseconds)
       * @type {number}
       */
      this.timeout = this._config.locals.remote.timeout;

      /**
       * Handlers information
       *
       * @type {{error: (ErrorCallback), status: (StatusCallback), data: (DataCallback)}}
       * @private
       */
      this._handlers = config.handlers;

      // Build the express sub-app
      this._app = express();
      const app = this._app;
      app.use(bodyParser.json());
      app.use(compression());
      
      const handlers = this._handlers;

      app.post('/data', (req, resp) => {

        resp.json({
          success: true
        });

        handlers.data(new Data(req.body), req);
      });

      app.post('/signal', (req, resp) => {
        resp.json({
          success: true
        });

        handlers.status(req.body.signal, req);
      });

      config.app.use(this._pathname, app);
    }

    get app() { return this._app; }

    get endpoint() { return this._servUrl; }

    _remoteUrl(path, query) {
      return url.format(_.extend(this._servUrl, {
        pathname: path,
        query: query
      }));
    }

    /**
     * Connect to the streaming service, this will register with the end point and bind to the requested port.
     * @param {errorCallback} next Called after binding
     */
    connect(next) {
      const req = {
        uri: this._remoteUrl('/register'),
        json: {
          href: (!!this._local ? this._local : undefined),
          verb: 'POST'
        },
        timeout: this.timeout
      };

      request.put(req, (err, resp, body) => {
        if (!err) {
          if (resp.statusCode != 200) {
            err = new Error(`Bad status code: ${resp.statusCode}\nError: ${req.uri}, ${util.inspect(resp.body)}`);
          }
        }

        if (_.isFunction(next)) {
          next(err);
        } else if (!!err) {
          throw err;
        }
      });
    }

    /**
     * Disconnect from the service
     * @param {errorCallback} [next]
     */
    disconnect(next) {
      const req = {
        url: this._remoteUrl('/register'),
        json: { href: this._local, verb: 'POST' },
        timeout: this.timeout
      };

      request.del(req, err => {
        if (_.isFunction(next)) {
          next(err);
        } else if (!!err) {
          throw err;
        }
      });
    }

    /**
     * Start the service streaming
     * @param {ErrorCallback} [next]
     */
    start(next) {
      if (!this._secret) {
        let err = new Error('Secret is not specified, server requests are unavailable.');
        if (_.isFunction(next)) {
          next(err);
        } else {
          throw err;
        }
      }

      const uri = this._remoteUrl('/serv/start', { 'token': this._secret });

      request.get({
        url: uri,
        timeout: this.timeout
      }, (err, resp, body) => {
        if (!err) {
          if (resp.statusCode != 200) {
            err = new Error("Bad status code: " + resp.statusCode + '\nError: ' + body);
          }
        }

        if (_.isFunction(next)) {
          next(err);
        } else if (!!err) {
          throw err;
        }
      });
    }

    /**
     * Start the service streaming
     * @param {ErrorCallback} [next]
     */
    stop(next) {
      if (!this._secret) {
        let err = new Error('Secret is not specified, server requests are unavailable.');
        if (_.isFunction(next)) {
          next(err);
        } else {
          throw err;
        }
      }

      const uri = this._remoteUrl('/serv/stop', { 'token': this._secret });

      request.get({
        url: uri,
        timeout: this.timeout
      }, (err, resp, body) => {
        if (!err) {
          if (resp.statusCode != 200) {
            err = new Error("Bad status code: " + resp.statusCode + '\nError: ' + body);
          }
        }

        if (_.isFunction(next)) {
          next(err);
        } else if (!!err) {
          throw err;
        }
      });
    }

    /**
     * Restart the streaming service with an optional date, `when`.
     * @param {ErrorCallback} [next]
     * @param {moment} [when]
     */
    restart(next, when) {
      if (!this._secret) {
        let err = new Error('Secret is not specified, server requests are unavailable.');
        if (_.isFunction(next)) {
          next(err);
        } else {
          throw err;
        }
      }


      const uri = this._remoteUrl('/serv/reset', {
        'token': this._secret,
        'date': (moment.isMoment(when) ? when.format('YYYY-MM-DD[T]hh:mm:ss') : undefined)
      });

      request.get({
        url: uri,
        timeout: this.timeout
      }, (err, resp, body) => {
        if (!err) {
          if (resp.statusCode != 200) {
            err = new Error("Bad status code: " + resp.statusCode + '\nError: ' + body);
          }
        }

        if (_.isFunction(next)) {
          next(err);
        } else if (!!err) {
          throw err;
        }
      });
    }


    /**
     *
     * @param {String} event
     * @param {(ErrorCallback|StatusCallback|DataCallback)} handler Handler
     */
    on(event, handler) {
      assert(_.isString(event) && _.isFunction(handler));

      switch (event) {
        case 'error': {
          this._handlers.error = handler;
        } break;

        case 'status': {
          this._handlers.status = handler;
        } break;

        case 'data': {
          this._handlers.data = handler;
        } break;

        default: {
          this._handlers.error(new Error('Unknown event: ' + event));
        }
      }
    }

  }

  return {
    StockClient: Client,
    Data: Data
  };
};
