var _ = require('underscore'),
  async = require('async'),
  bag = require('bagofholding'),
  cron = require('cron'),
  Db = require('./db'),
  fs = require('fs'),
  fsx = require('fs.extra'),
  p = require('path');

/**
 * class Couchpenter
 *
 * @param {String} url: CouchDB URL in format http(s)://user:pass@host:port, fallback to COUCHDB_URL environment variable, default to http://localhost:5984
 * @param {String} opts: optional
 * - setupFile: Couchpenter setup file
 * - dir: documents directory
 * - prefix: prefix for database names
 * - dbSetup: Couchpenter database setup object
 */
function Couchpenter(url, opts) {
  opts = opts || {};

  this.url = url || process.env.COUCHDB_URL || 'http://localhost:5984';
  this.opts = {
    setupFile: opts.setupFile || 'couchpenter.json',
    dir: opts.dir || process.cwd(),
    prefix: opts.prefix,
    setup: opts.dbSetup,
    interval: opts.interval
  };
}

/**
 * Create a sample couchpenter.json setup file in current working directory.
 *
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype.init = function (cb) {
  console.log('Creating sample setup file: couchpenter.json');
  fsx.copy(p.join(__dirname, '../examples/couchpenter.json'), 'couchpenter.json', cb);
};

// NOTE: pardon this method to tasks mapping,
// needed to preserve backward compatibility w/ v0.1.x

/**
 * Create databases and documents, overwrite if documents exist.
 *
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype.setUp = function (cb) {
  this._task(['createDatabases', 'saveDocuments'], cb);
};

/**
 * Create databases only.
 *
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype.setUpDatabases = function (cb) {
  this._task(['createDatabases'], cb);
};

/**
 * Create documents only, does not overwrite if exist.
 *
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype.setUpDocuments = function (cb) {
  this._task(['createDocuments'], cb);
};

/**
 * Create documents only, overwrite if exist.
 *
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype.setUpDocumentsOverwrite = function (cb) {
  this._task(['saveDocuments'], cb);
};

/**
 * Alias for tearDownDatabases.
 *
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype.tearDown = function (cb) {
  this.tearDownDatabases(cb);
};

/**
 * Delete databases.
 *
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype.tearDownDatabases = function (cb) {
  this._task(['removeDatabases'], cb);
};

/**
 * Delete documents.
 *
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype.tearDownDocuments = function (cb) {
  this._task(['removeDocuments'], cb);
};

/**
 * Alias for resetDocuments.
 *
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype.reset = function (cb) {
  this.resetDocuments(cb);
};

/**
 * Delete then recreate databases.
 *
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype.resetDatabases = function (cb) {
  this._task(['removeDatabases', 'createDatabases'], cb);
};

/**
 * Delete then recreate documents only.
 *
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype.resetDocuments = function (cb) {
  this._task(['removeDatabases', 'createDatabases', 'createDocuments'], cb);
};

/**
 * Alias for cleanDatabases.
 *
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype.clean = function (cb) {
  this.cleanDatabases(cb);
};

/**
 * Delete unknown databases (not configured in setup file).
 *
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype.cleanDatabases = function (cb) {
  this._task(['cleanDatabases'], cb);
};

/**
 * Warm up views specified in design documents.
 * If schedule is specified, then views warm up will be scheduled using cron.
 * Otherwise, it's just a once off.
 * 
 * @param {String} schedule: cron scheduling definition in standard * * * * * format
 * @param {Function} cb: standard cb(err, result) callback
 */ 
Couchpenter.prototype.warmViews = function(schedule, cb) {
  var self = this;
  if (cb) {
    new cron.CronJob(
      schedule,
      function () {
          self._task(['warmViews'], cb);
      },
      function () {
        cb(null, {
          id: 'couchpenter',
          message: 'stopped views warm up schedule'
        });
      },
      true);
  } else {
    cb = schedule;
    this._task(['warmViews'], cb);
  }
};

/**
 * Get view index progress for Db specified
 * 
 */
Couchpenter.prototype.liveDeployView = function (cb) {
  this._task(['liveDeployView'], cb);
};

/**
 * Execute database tasks in series order.
 *
 * @param {Array} tasks: the tasks to execute
 * @param {Function} cb: standard cb(err, result) callback
 */
Couchpenter.prototype._task = function (tasks, cb) {  
  var setup = this.opts.setup || JSON.parse(bag.cli.lookupFile(this.opts.setupFile)),
    db = new Db(this.url, { interval: this.opts.interval }),
    asyncTasks = [],
    self = this;

  // prefix database names if optional prefix is specified
  if (this.opts.prefix) {
    _.keys(setup).forEach(function (dbName) {
      setup[self.opts.prefix + dbName] = setup[dbName];
      delete setup[dbName];
    });
  }

  tasks.forEach(function (taskName) {
    asyncTasks.push(function (cb) {
      var data = (taskName.match(/Databases$/)) ?  _.keys(setup) : self._docs(setup, self.opts.dir);
      db[taskName](data, cb);
    });
  });

  async.series(asyncTasks, function (err, results) {
    var combined = [];
    results.forEach(function (result) {
      combined = combined.concat(result);
    });
    cb(err, combined);
  });
};

/**
 * Process documents in Couchpenter setup:
 * - if it's an object, leave as-is
 * - if it's a json file location (ending with .json) then assign the content of the file as the document
 * - otherwise assume it's a module, and require it
 * Location of file and module is relative to this.opts.dir .
 *
 * @param {Object} setup: Couchpenter setup
 * @param {String} dir: base directory relative to file location
 * @return {Object} setup with documents processed
 */
Couchpenter.prototype._docs = function (setup, dir) {
  _.keys(setup).forEach(function (dbName) {
    for (var i = 0, ln = setup[dbName].length; i < ln; i += 1) {
      var item = setup[dbName][i];
      if (_.isString(item)) {
        if (item.match(/\.json$/)) {
          setup[dbName][i] = JSON.parse(fs.readFileSync(p.join(dir, item)));
        } else {
          setup[dbName][i] = require(p.join(dir, item));
        }
      } else if (!Array.isArray(item) && !_.isObject(item)) {
        throw new Error('Invalid document ' + item + ' in db ' + dbName + ', only object and string allowed');
      }
    }
  });
  return setup;
};

module.exports = Couchpenter;
