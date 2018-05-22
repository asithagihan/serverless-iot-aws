const path = require("path");
const _ = require("lodash");
const mqttMatch = require("mqtt-match");
const AWS = require("aws-sdk");

const IoTSDK = require("aws-iot-device-sdk");
const SQL = require("./sql");

// TODO: send PR to serverless-offline to export this
const functionHelper = require("serverless-offline/src/functionHelper");
const createLambdaContext = require("serverless-offline/src/createLambdaContext");

const VERBOSE = typeof process.env.SLS_DEBUG !== "undefined";
const defaultOpts = {
  host: "localhost",
  location: ".",
  port: 1883,
  httpPort: 1884,
  noStart: false,
  skipCacheInvalidation: false
};

class ServerlessIotLocal {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.log = serverless.cli.log.bind(serverless.cli);
    this.service = serverless.service;
    this.options = options;
    this.provider = "aws";
    this.mqttBroker = null;
    this.requests = {};

    this.commands = {
      iot: {
        commands: {
          start: {
            usage: "Start local Iot broker.",
            lifecycleEvents: ["startHandler"],
            options: {
              host: {
                usage: "host name to listen on. Default: localhost",
                // match serverless-offline option shortcuts
                shortcut: "o"
              },
              port: {
                usage: "MQTT port to listen on. Default: 1883",
                shortcut: "p"
              },
              httpPort: {
                usage:
                  "http port for client connections over WebSockets. Default: 1884",
                shortcut: "h"
              },
              noStart: {
                shortcut: "n",
                usage:
                  "Do not start local MQTT broker (in case it is already running)"
              },
              skipCacheInvalidation: {
                usage:
                  "Tells the plugin to skip require cache invalidation. A script reloading tool like Nodemon might then be needed",
                shortcut: "c"
              }
            }
          }
        }
      }
    };

    this.hooks = {
      "iot:start:startHandler": this.startHandler.bind(this),
      "before:offline:start:init": this.startHandler.bind(this),
      "before:offline:start": this.startHandler.bind(this),
      "before:offline:start:end": this.endHandler.bind(this)
    };
  }

  debug() {
    if (VERBOSE) {
      this.log.apply(this, arguments);
    }
  }

  startHandler() {
    this.originalEnvironment = _.extend({ IS_OFFLINE: true }, process.env);
    this.options = _.merge(
      {},
      defaultOpts,
      (this.service.custom || {})["serverless-iot-local"],
      this.options
    );

    this._getAWSConfig()
      .then(ioTClientOptions => {
        this.options = {
          ...ioTClientOptions,
          ...this.options
        };

        this._createAWSClient();
      })
      .catch(error => console.log(error));
  }

  endHandler() {
    this.log("Stopping Iot broker");
    this.mqttBroker.close();
  }

  _getAWSConfig() {
    const config = {
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretKey,
      region: this.options.sessionToken
    };
    AWS.config.update(config);

    const STS = new AWS.STS();
    const roleName = this.options.roleName;

    return new Promise((resolve, reject) => {
      STS.getCallerIdentity({}, (error, data) => {
        if (error) reject(error);

        const params = {
          RoleArn: `arn:aws:iam::${data.Account}:role/${roleName}`,
          RoleSessionName: Math.random().toString()
        };
        STS.assumeRole(params, (err, { Credentials }) => {
          if (err) reject(err);

          resolve({
            ...Credentials,
            region: this.options.region,
            host: this.options.endPoint
          });
        });
      });
    });
  }

  _createAWSClient() {
    const { port, httpPort, location } = this.options;
    const topicsToFunctionsMap = {};
    const { runtime } = this.service.provider;
    Object.keys(this.service.functions).forEach(key => {
      const fun = this._getFunction(key);
      const funName = key;
      const servicePath = path.join(
        this.serverless.config.servicePath,
        location
      );
      const funOptions = functionHelper.getFunctionOptions(
        fun,
        key,
        servicePath
      );
      this.debug(`funOptions ${JSON.stringify(funOptions, null, 2)} `);

      if (!fun.environment) {
        fun.environment = {};
      }

      fun.environment.AWS_LAMBDA_FUNCTION_NAME = `${this.service.service}-${
        this.service.provider.stage
        }-${funName}`;

      this.debug("");
      this.debug(funName, "runtime", runtime, funOptions.babelOptions || "");
      this.debug(`events for ${funName}:`);

      if (!(fun.events && fun.events.length)) {
        this.debug("(none)");
        return;
      }

      fun.events.forEach(event => {
        if (!event.iot) return this.debug("(none)");

        const { iot } = event;
        const { sql } = iot;
        // hack
        // assumes SELECT ... topic() as topic
        const parsed = SQL.parseSelect(sql);
        const topicMatcher = parsed.topic;
        if (!topicsToFunctionsMap[topicMatcher]) {
          topicsToFunctionsMap[topicMatcher] = [];
        }

        this.debug("topicMatcher");
        topicsToFunctionsMap[topicMatcher].push({
          fn: fun,
          name: key,
          options: funOptions,
          select: parsed.select
        });
      });
    });

    const client = IoTSDK.device({
      clientId: this.options.clientId || "",
      region: this.options.region,
      host: this.options.host,
      protocol: this.options.protocol || "wss",

      // Reconnect timeout
      baseReconnectTimeMs: this.options.baseReconnectTimeMs || 250,
      maximumReconnectTimeMs: this.options.maximumReconnectTimeMs || 500,

      // Enable console debugging information
      debug:
        typeof this.options.debug === "undefined" ? true : this.options.debug,

      // AWS access key ID, secret key and session token must be
      // initialized with empty strings
      accessKeyId: this.options.AccessKeyId || "",
      secretKey: this.options.SecretAccessKey || "",
      sessionToken: this.options.SessionToken || "",

      // Dissable auto subscription
      autoResubscribe:
        typeof this.options.debug === "undefined"
          ? false
          : this.options.autoResubscribe
    });

    client.on("error", console.error);

    const connectMonitor = setInterval(() => {
      this.log(`still haven't connected to local Iot broker!`);
    }, 5000).unref();

    // AWS.mock("IotData", "publish", (params, callback) => {
    //   const { topic, payload } = params;
    //   client.publish(topic, payload, {}, callback);
    // });

    // const endpointAddress = `${this.options.host}:${httpPort}`;

    // AWS.mock("Iot", "describeEndpoint", callback => {
    //   process.nextTick(() => {
    //     callback(null, { endpointAddress });
    //   });
    // });

    client.on("connect", () => {
      clearInterval(connectMonitor);
      this.log("connected to local Iot broker");
      for (let topicMatcher in topicsToFunctionsMap) {
        client.subscribe(topicMatcher);
      }
    });

    client.on("message", (topic, message) => {
      const matches = Object.keys(topicsToFunctionsMap).filter(topicMatcher =>
        mqttMatch(topicMatcher, topic)
      );

      if (!matches.length) return;

      let clientId;
      if (/^\$aws\/events/.test(topic)) {
        clientId = topic.slice(topic.lastIndexOf("/") + 1);
      } else {
        // hmm...
      }

      const apiGWPort = this._getServerlessOfflinePort();
      matches.forEach(topicMatcher => {
        const functions = topicsToFunctionsMap[topicMatcher];
        functions.forEach(fnInfo => {
          const { fn, name, options, select } = fnInfo;
          const requestId = Math.random()
            .toString()
            .slice(2);
          this.requests[requestId] = { done: false };

          const event = SQL.applySelect({
            select,
            payload: message,
            context: {
              topic: () => topic,
              clientid: () => clientId
            }
          });

          let handler; // The lambda function
          try {
            process.env = _.extend(
              {},
              this.service.provider.environment,
              this.service.functions[name].environment,
              this.originalEnvironment
            );
            process.env.SERVERLESS_OFFLINE_PORT = apiGWPort;
            handler = functionHelper.createHandler(options, this.options);
          } catch (err) {
            this.log(`Error while loading ${name}: ${err.stack}, ${requestId}`);
            return;
          }

          const lambdaContext = createLambdaContext(fn);
          try {
            handler(event, lambdaContext, lambdaContext.done);
          } catch (error) {
            this.log(
              `Uncaught error in your '${name}' handler: ${
              error.stack
              }, ${requestId}`
            );
          }
        });
      });
    });
  }

  // _createMQTTBroker() {
  //   const { host, port, httpPort, backend } = this.options
  //   IoTClientOptions = IoT.getTemporaryCredentials();

  //   this.mqttBroker = createMQTTBroker({
  //     host,
  //     port,
  //     http: {
  //       host,
  //       port: httpPort,
  //       bundle: true
  //     },
  //     backend
  //   })

  //   const endpointAddress = `${IP.address()}:${httpPort}`

  //   // prime AWS IotData import
  //   // this is necessary for below mock to work
  //   // eslint-disable-next-line no-unused-vars
  //   const notUsed = new realAWS.IotData({
  //     endpoint: endpointAddress,
  //     region: 'us-east-1'
  //   })

  //   AWS.mock('IotData', 'publish', (params, callback) => {
  //     const { topic, payload } = params
  //     this.mqttBroker.publish({ topic, payload }, callback)
  //   })

  //   AWS.mock('Iot', 'describeEndpoint', callback => {
  //     process.nextTick(() => {
  //       callback(null, { endpointAddress })
  //     })
  //   })

  //   this.log(`Iot broker listening on ports: ${port} (mqtt) and ${httpPort} (http)`)
  // }

  _getServerlessOfflinePort() {
    // hackeroni!
    const offline = this.serverless.pluginManager.plugins.find(
      plugin => plugin.commands && plugin.commands.offline
    );

    if (offline) {
      return offline.options.port;
    }
  }

  // _createMQTTClient() {
  //   const { port, httpPort, location } = this.options
  //   const topicsToFunctionsMap = {}
  //   const { runtime } = this.service.provider
  //   Object.keys(this.service.functions).forEach(key => {
  //     const fun = this._getFunction(key)
  //     const funName = key
  //     const servicePath = path.join(this.serverless.config.servicePath, location)
  //     const funOptions = functionHelper.getFunctionOptions(fun, key, servicePath)
  //     this.debug(`funOptions ${JSON.stringify(funOptions, null, 2)} `)

  //     if (!fun.environment) {
  //       fun.environment = {}
  //     }

  //     fun.environment.AWS_LAMBDA_FUNCTION_NAME = `${this.service.service}-${this.service.provider.stage}-${funName}`

  //     this.debug('')
  //     this.debug(funName, 'runtime', runtime, funOptions.babelOptions || '')
  //     this.debug(`events for ${funName}:`)

  //     if (!(fun.events && fun.events.length)) {
  //       this.debug('(none)')
  //       return
  //     }

  //     fun.events.forEach(event => {
  //       if (!event.iot) return this.debug('(none)')

  //       const { iot } = event
  //       const { sql } = iot
  //       // hack
  //       // assumes SELECT ... topic() as topic
  //       const parsed = SQL.parseSelect(sql)
  //       const topicMatcher = parsed.topic
  //       if (!topicsToFunctionsMap[topicMatcher]) {
  //         topicsToFunctionsMap[topicMatcher] = []
  //       }

  //       this.debug('topicMatcher')
  //       topicsToFunctionsMap[topicMatcher].push({
  //         fn: fun,
  //         name: key,
  //         options: funOptions,
  //         select: parsed.select
  //       })
  //     })
  //   })

  //   const iotClient = IotClient.init({
  //     region: IoTClientOptions.region,
  //     host: IoTClientOptions.host,
  //     accessKeyId: IoTClientOptions.AccessKeyId,
  //     secretKey: IoTClientOptions.SecretAccessKey,
  //     sessionToken: IoTClientOptions.SessionToken
  //   });

  //   iotClient.onConnect(() => {
  //     clearInterval(connectMonitor)
  //     this.log('connected to local Iot broker')
  //     for (let topicMatcher in topicsToFunctionsMap) {
  //       client.subscribe(topicMatcher)
  //     }
  //   });

  //   iotClient.onSubscribe((topic, message) => {
  //     const matches = Object.keys(topicsToFunctionsMap)
  //       .filter(topicMatcher => mqttMatch(topicMatcher, topic))

  //     if (!matches.length) return

  //     let clientId
  //     if (/^\$aws\/events/.test(topic)) {
  //       clientId = topic.slice(topic.lastIndexOf('/') + 1)
  //     } else {
  //       // hmm...
  //     }

  //     const apiGWPort = this._getServerlessOfflinePort()
  //     matches.forEach(topicMatcher => {
  //       let functions = topicsToFunctionsMap[topicMatcher]
  //       functions.forEach(fnInfo => {
  //         const { fn, name, options, select } = fnInfo
  //         const requestId = Math.random().toString().slice(2)
  //         this.requests[requestId] = { done: false }

  //         const event = SQL.applySelect({
  //           select,
  //           payload: message,
  //           context: {
  //             topic: () => topic,
  //             clientid: () => clientId
  //           }
  //         })

  //         let handler // The lambda function
  //         try {
  //           process.env = _.extend({}, this.service.provider.environment, this.service.functions[name].environment, this.originalEnvironment)
  //           process.env.SERVERLESS_OFFLINE_PORT = apiGWPort
  //           handler = functionHelper.createHandler(options, this.options)
  //         } catch (err) {
  //           this.log(`Error while loading ${name}: ${err.stack}, ${requestId}`)
  //           return
  //         }

  //         const lambdaContext = createLambdaContext(fn)
  //         try {
  //           handler(event, lambdaContext, lambdaContext.done)
  //         } catch (error) {
  //           this.log(`Uncaught error in your '${name}' handler: ${error.stack}, ${requestId}`)
  //         }
  //       })
  //     })
  //   });

  //   const client = mqtt.connect(`ws://localhost:${httpPort}/mqqt`)
  //   client.on('error', console.error)

  //   const connectMonitor = setInterval(() => {
  //     this.log(`still haven't connected to local Iot broker!`)
  //   }, 5000).unref()

  //   client.on('connect', () => {
  //     clearInterval(connectMonitor)
  //     this.log('connected to local Iot broker')
  //     for (let topicMatcher in topicsToFunctionsMap) {
  //       client.subscribe(topicMatcher)
  //     }
  //   })

  //   client.on('message', (topic, message) => {
  //     const matches = Object.keys(topicsToFunctionsMap)
  //       .filter(topicMatcher => mqttMatch(topicMatcher, topic))

  //     if (!matches.length) return

  //     let clientId
  //     if (/^\$aws\/events/.test(topic)) {
  //       clientId = topic.slice(topic.lastIndexOf('/') + 1)
  //     } else {
  //       // hmm...
  //     }

  //     const apiGWPort = this._getServerlessOfflinePort()
  //     matches.forEach(topicMatcher => {
  //       let functions = topicsToFunctionsMap[topicMatcher]
  //       functions.forEach(fnInfo => {
  //         const { fn, name, options, select } = fnInfo
  //         const requestId = Math.random().toString().slice(2)
  //         this.requests[requestId] = { done: false }

  //         const event = SQL.applySelect({
  //           select,
  //           payload: message,
  //           context: {
  //             topic: () => topic,
  //             clientid: () => clientId
  //           }
  //         })

  //         let handler // The lambda function
  //         try {
  //           process.env = _.extend({}, this.service.provider.environment, this.service.functions[name].environment, this.originalEnvironment)
  //           process.env.SERVERLESS_OFFLINE_PORT = apiGWPort
  //           handler = functionHelper.createHandler(options, this.options)
  //         } catch (err) {
  //           this.log(`Error while loading ${name}: ${err.stack}, ${requestId}`)
  //           return
  //         }

  //         const lambdaContext = createLambdaContext(fn)
  //         try {
  //           handler(event, lambdaContext, lambdaContext.done)
  //         } catch (error) {
  //           this.log(`Uncaught error in your '${name}' handler: ${error.stack}, ${requestId}`)
  //         }
  //       })
  //     })
  //   })
  // }

  _getFunction(key) {
    const fun = this.service.getFunction(key);
    if (!fun.timeout) {
      fun.timeout = this.service.provider.timeout;
    }

    return fun;
  }
}

module.exports = ServerlessIotLocal;
