# Stock Client Library

## Usage

```js
const lib = require('stock-client');

// Create an express application
const app = require('express');

// load a configuration object with "stock-data" loaded as a ServiceURL
const cfg = require('blue-config')('./config');

// Create a client sub-app
const client = new lib.StockClient({
  app: app,
  config: cfg,
  locals: {
    local: {
      pathname: "/client" // Location the application is installed into
    },
    remote: {
      secret: "",         // secret used for the stock-server
      timeout: 15000      // Milliseconds to wait between requests
    }
  },
  handlers: {
    data: (data) => {
      // data is a a lib.Data object
      // This is called every time Data is sent from the server. 
    }
  }
});
```