# serverless-iot-aws

AWS Iot lifecycle and regular topic subscription events

## Prerequisites

* serverless@1.x

## Install

1. `npm install --save serverless-iot-aws`

2. In `serverless.yml` add `serverless-iot-aws` to plugins:

```yaml
plugins:
  - serverless-iot-aws
```

## Usage

1. If you're using [serverless-offline](https://github.com/dherault/serverless-offline), you can run:

   `sls offline start`

   Otherwise run:

   `sls iot start`

CLI options are optional:

The above options must be added to serverless.yml to set default configuration, e.g.:

```yml
custom:
  serverless-iot-aws:
    accessKeyId: ""
    secretKey: ""
    region : ""
    roleName : ""
    host: ""
```

### Using with serverless-offline plugin

Place `serverless-iot-aws` above `serverless-offline`

```yaml
plugins:
  - serverless-iot-aws
  - serverless-offline
```

## Todo

* Improve support of AWS Iot SQL syntax

## Known issuses

## License

[MIT](LICENSE)
