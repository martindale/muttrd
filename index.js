/**
 * @module muttrd
 */

'use strict';

var async = require('async');
var util = require('util');
var muttr = require('muttr');
var toml = require('toml');
var colors = require('colors/safe');
var fs = require('fs');
var events = require('events');
var ipc = require('ipsee');
var merge = require('merge');
var path = require('path');
var levelup = require('levelup');
var nat = require('nat-upnp');

util.inherits(Muttrd, events.EventEmitter);

Muttrd.DEFAULTS = {
  datadir: path.join(process.env.HOME, '.muttrd'),
  names: {
    pubkey: 'id_pgp.pub',
    privkey: 'id_pgp',
    store: 'muttrd.db',
    config: 'muttrd.conf'
  }
};

/**
 * Creates a muttrd service
 * @constructor
 * @param {Object} options
 */
function Muttrd(options) {
  if (!(this instanceof Muttrd)) {
    return new Muttrd(options);
  }

  this.options = merge(Object.create(Muttrd.DEFAULTS), options);
}

/**
 * Starts the muttrd instance
 * #start
 * @param {Function} callback
 */
Muttrd.prototype.start = function(callback) {
  async.series(this._init(), function(err) {
    if (err) {
      log('Error!', err);
    }
  });
};

/**
 * Returns initializer stack
 * #_init
 */
Muttrd.prototype._init = function() {
  var self = this;
  var stack = [];

  stack.push(this._setupDataDirectory);
  stack.push(this._prepareIdentity);
  stack.push(this._connectToNetwork);
  stack.push(this._createSession);
  stack.push(this._bindIPCInterface);

  return stack.map(function(executor) {
    return executor.bind(self);
  });
};

/**
 * Sets up IPC bindings
 * #_bindIPCInterface
 * @param {Function} callback
 */
Muttrd.prototype._bindIPCInterface = function(callback) {
  var self = this;

  this.ipc = ipc('muttrd', { uid: 'svc' }).subscribe();

  this.session.on('message', function(message) {
    log('Received a message located at %s', message.key);
    self.ipc.send('message', message);
  });

  this.ipc.on('send', function(data) {
    log('Sending message to %s...', data.to);
    self.session.send(data.to, data.message, function(err, msg) {
      log('----> %s', err ? 'Failed!' : 'Success!');
      log(err);
      self.ipc.send(data.ref, {
        error: err ? err.message : null,
        result: msg
      });
    });
  });

  this.ipc.on('playback', function(data) {
    log('Received playback command...');
    self.session.playback(function(err, messages) {
      log('----> %s', err ? 'Failed!' : 'Success!');
      self.ipc.send(data.ref, {
        error: err ? err.message : null,
        result: messages
      });
    });
  });

  this.ipc.on('purge', function(data) {
    log('Received purge command...');
    self.session._purge(function(err) {
      log('----> %s', err ? 'Failed!': 'Success!');
      self.ipc.send(data.ref, {
        error: err ? err.message : null
      });
    });
  });

  process.on('exit', this.ipc.close.bind(this.ipc));

  callback();
};

/**
 * Creates a muttr Session instance
 * #_createSession
 * @param {Function} callback
 */
Muttrd.prototype._createSession = function(callback) {
  log('Preparing session...');

  if (this.config.promiscuous === true) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  this.session = new muttr.Session(this.identity, this.connection);

  this.session.on('ready', function() {
    log('----> Ready!');
  });

  this.session.on('error', function(err) {
    log(colors.red('Error'), err.stack);
  });

  callback();
};

/**
 * Loads the user identity from the datadir
 * #_prepareIdentity
 * @param {Function} callback
 */
Muttrd.prototype._prepareIdentity = function(callback) {
  log('Loading PGP identity...');

  this.identity = new muttr.Identity(
    this.config.identity.user_id,
    this.config.identity.passphrase,
    {
      publicKey: fs.readFileSync(this.datadir('pubkey')).toString(),
      privateKey: fs.readFileSync(this.datadir('privkey')).toString()
    }
  );

  log('----> Done!');
  callback();
};

/**
 * Setup connection to the DHT
 * #_connectToNetwork
 * @param {Function} callback
 */
Muttrd.prototype._connectToNetwork = function(callback) {
  var self = this;
  var upnp = nat.createClient();

  if (this.config.passive) {
    return callback();
  }

  if (!this.config.network.portmap) {
    self.connection = new muttr.Connection(merge(self.config.network, {
      forwardPort: false,
      storage: levelup(self.datadir('store'))
    }));

    return callback();
  }

  log(
    'Creating port mapping from %s <--> %s...',
    this.config.network.port,
    this.config.network.port
  );

  upnp.portMapping({
    public: this.config.network.port,
    private: this.config.network.port,
    ttl: 0
  }, function(err) {
    if (err) {
      log('----> Failed!');
      log('Session will be initialized in "passive" mode');
      return callback();
    }

    upnp.externalIp(function(err, ip) {
      if (err) {
        log('----> Failed!');
        log('Session will be initialized in "passive" mode');
        return callback();
      }

      self.config.network.address = ip;
      self.connection = new muttr.Connection(merge(self.config.network, {
        forwardPort: false,
        storage: levelup(self.datadir('store'))
      }));

      callback();
    });
  });
};

/**
 * Ensures datadir is properly setup
 * #_setupDataDirectory
 * @param {Function} callback
 */
Muttrd.prototype._setupDataDirectory = function(callback) {
  var self = this;

  if (!fs.existsSync(this.datadir())) {
    log('Data directory does not exist, so I will create it...');
    fs.mkdirSync(this.datadir());
    log('----> Done!');
  }

  if (!fs.existsSync(this.datadir('config'))) {
    fs.writeFileSync(
      this.datadir('config'),
      fs.readFileSync(path.join(__dirname, 'default.conf'))
    );
    log('The default config has been written to %s', this.datadir('config'));
    log('----> Edit the `identity.user_id` and `identity.passphrase`');
    log('----> Then run this program again');
    return;
  }

  try {
    this.config = toml.parse(fs.readFileSync(this.datadir('config')));
    log('Loaded config file from %s', this.datadir('config'));
  } catch(err) {
    return log('Could not parse config file:', err.message);
  }

  if (!fs.existsSync(this.datadir('privkey'))) {
    log('No identity found in data directory, so I will generate one...');
    muttr.Identity.generate(
      this.config.identity.user_id,
      this.config.identity.passphrase,
      function(err, identity) {
        if (err) {
          return callback(err);
        }

        log('----> Done!');
        log('Writing PGP identity files to data directory...');
        fs.writeFileSync(self.datadir('privkey'), identity._privateKeyArmored);
        fs.writeFileSync(self.datadir('pubkey'), identity._publicKeyArmored);
        log('----> Done!');
        callback();
      }
    );
  } else {
    callback();
  }
};

/**
 * Returns path to data dir or resource inside
 * #datadir
 * @param {String} name
 */
Muttrd.prototype.datadir = function(name) {
  return path.join(this.options.datadir, this.options.names[name] || '');
};

/**
 * #exports
 */
module.exports = Muttrd;

/**
 * Logger helper
 * #log
 * @param {Mixed} content
 */
function log() {
  var args = Array.prototype.slice.call(arguments);
  var message = colors.bold('muttrd: ') + args.shift();

  args.unshift(message);
  console.log.apply(console, args);
}
