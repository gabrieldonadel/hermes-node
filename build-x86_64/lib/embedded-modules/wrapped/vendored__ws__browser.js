(function(exports, require, module, __filename, __dirname) {'use strict';

module.exports = function () {
  throw new Error(
    'ws does not work in the browser. Browser clients must use the native ' +
      'WebSocket object'
  );
};

});
//# sourceURL=vendored/ws/browser
