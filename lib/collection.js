
/**
 * Module dependencies
 */

var _ = require('lodash'),
    async = require('async'),
    utils = require('./utils'),
    Document = require('./document'),
    Query = require('./query'),
    ObjectId = require('mongodb').ObjectID,
    Errors = require('waterline-errors').adapter;

/**
 * Manage A Collection
 *
 * @param {Object} definition
 * @api public
 */

var Collection = module.exports = function Collection(definition, connection) {

  // Set an identity for this collection
  this.identity = '';

  // Hold Schema Information
  this.schema = null;

  // Hold a reference to an active connection
  this.connection = connection;

  // Hold Indexes
  this.indexes = [];

  // Parse the definition into collection attributes
  this._parseDefinition(definition);

  // Build an indexes dictionary
  this._buildIndexes();

  return this;
};


/////////////////////////////////////////////////////////////////////////////////
// PUBLIC METHODS
/////////////////////////////////////////////////////////////////////////////////

/**
 * Find Documents
 *
 * @param {Object} criteria
 * @param {Function} callback
 * @api public
 */

Collection.prototype.find = function find(criteria, cb) {
  var self = this,
      query;

  // Catch errors from building query and return to the callback
  try {
    query = new Query(criteria, this.schema);
  } catch(err) {
    return cb(err);
  }

  var collection = this.connection.db.collection(self.identity);

  // Check for aggregate query
  if(query.aggregate) {
    var aggregate = [
      { '$match': query.criteria.where || {} },
      { '$group': query.aggregateGroup }
    ];

    return collection.aggregate(aggregate, function(err, results) {

      // Results have grouped by values under _id, so we extract them
      var mapped = results.map(function(result) {
        for(var key in result._id) {
          result[key] = result._id[key];
        }
        delete result._id;
        return result;
      });

      cb(err, mapped);
    });
  }

  var where = query.criteria.where || {};
  var projection = query.projection;
  var queryOptions = _.omit(query.criteria, 'where');
  queryOptions = _.merge(queryOptions, projection);
  
  // Run Normal Query on collection
  collection.find(where, queryOptions).toArray(function(err, docs) {
    if(err) return cb(err);
    cb(null, utils.rewriteIds(docs, self.schema));
  });
};

/**
 * Insert A New Document
 *
 * @param {Object|Array} values
 * @param {Function} callback
 * @api public
 */

Collection.prototype.insert = function insert(values, cb) {
  var self = this;

  // Normalize values to an array
  if(!Array.isArray(values)) values = [values];

  // Build a Document and add the values to a new array
  var docs = values.map(function(value) {
    return new Document(value, self.schema).values;
  });

  this.connection.db.collection(this.identity).insert(docs, function(err, results) {
    if(err) return cb(err);
    cb(null, utils.rewriteIds(results, self.schema));
  });
};

/**
 * Update Documents
 *
 * @param {Object} criteria
 * @param {Object} values
 * @param {Function} callback
 * @api public
 */

Collection.prototype.update = function update(criteria, values, cb) {
  var self = this,
      query;

  // Catch errors build query and return to the callback
  try {
    query = new Query(criteria, this.schema);
  } catch(err) {
    return cb(err);
  }

  values = new Document(values, this.schema).values;

  // Mongo doesn't allow ID's to be updated
  if(values.id) delete values.id;
  if(values._id) delete values._id;

  var collection = this.connection.db.collection(self.identity);

  // Lookup records being updated and grab their ID's
  // Useful for later looking up the record after an insert
  // Required because options may not contain an ID
  collection.find(query.criteria.where).toArray(function(err, records) {
    if(err) return cb(err);
    if(!records) return cb(Errors.NotFound);

    // Build an array of records
    var updatedRecords = [];

    records.forEach(function(record) {
      updatedRecords.push(record._id);
    });

    // Update the records
    collection.update(query.criteria.where, { '$set': values }, { multi: true }, function(err, result) {
      if(err) return cb(err);

      // Look up newly inserted records to return the results of the update
      collection.find({ _id: { '$in': updatedRecords }}).toArray(function(err, records) {
        if(err) return cb(err);
        cb(null, utils.rewriteIds(records, self.schema));
      });
    });
  });
};

/**
 * Destroy Documents
 *
 * @param {Object} criteria
 * @param {Function} callback
 * @api public
 */

Collection.prototype.destroy = function destroy(criteria, cb) {
  var self = this,
      query;

  // Catch errors build query and return to the callback
  try {
    query = new Query(criteria, this.schema);
  } catch(err) {
    return cb(err);
  }

  var collection = this.connection.db.collection(self.identity);
  collection.remove(query.criteria.where, function(err, results) {
    if(err) return cb(err);

    // Force to array to meet Waterline API
    var resultsArray = [];

    // If result is not an array return an array
    if(!Array.isArray(results)) {
      resultsArray.push({ id: results });
      return cb(null, resultsArray);
    }

    // Create a valid array of IDs
    results.forEach(function(result) {
      resultsArray.push({ id: result });
    });

    cb(null, utils.rewriteIds(resultArray, self.schema));
  });
};

/**
 * Count Documents
 *
 * @param {Object} criteria
 * @param {Function} callback
 * @api public
 */

Collection.prototype.count = function count(criteria, cb) {

  var self = this;
  var query;

  // Catch errors build query and return to the callback
  try {
    query = new Query(criteria, this.schema);
  } catch(err) {
    return cb(err);
  }

  this.connection.db.collection(this.identity).count(query.criteria.where, function(err, count) {
    if (err) return cb(err);
    cb(null, count);
  });
};


/////////////////////////////////////////////////////////////////////////////////
// PRIVATE METHODS
/////////////////////////////////////////////////////////////////////////////////


/**
 * Get name of primary key field for this collection
 * 
 * @return {String}
 * @api private
 */
Collection.prototype._getPK = function _getPK () {

  // @clarorz, @particlebanana
  // does this look right to you fellas based on the current implementation?
  // ~Mike June 22, 2014
  return 'id';
};


/**
 * Parse Collection Definition
 *
 * @param {Object} definition
 * @api private
 */

Collection.prototype._parseDefinition = function _parseDefinition(definition) {
  var self = this,
      collectionDef = _.cloneDeep(definition);

  // Hold the Schema
  this.schema = collectionDef.definition;

  if (_.has(this.schema, 'id') && this.schema.id.primaryKey && this.schema.id.type === 'integer') {
    this.schema.id.type = 'objectid';
  }

  // Remove any Auto-Increment Keys, Mongo currently doesn't handle this well without
  // creating additional collection for keeping track of the increment values
  Object.keys(this.schema).forEach(function(key) {
    if(self.schema[key].autoIncrement) delete self.schema[key].autoIncrement;
  });

  // Replace any foreign key value types with ObjectId
  Object.keys(this.schema).forEach(function(key) {
    if(self.schema[key].foreignKey) {
      self.schema[key].type = 'objectid';
    }
  });

  // Set the identity
	var ident = definition.tableName ? definition.tableName : definition.identity.toLowerCase();
	this.identity = _.clone(ident);
};

/**
 * Build Internal Indexes Dictionary based on the current schema.
 *
 * @api private
 */

Collection.prototype._buildIndexes = function _buildIndexes() {
  var self = this;

  Object.keys(this.schema).forEach(function(key) {
    var index = {};
    var options = {};

    // If index key is `id` ignore it because Mongo will automatically handle this
    if(key === 'id') {
      return;
    }

    // Handle Unique Indexes
    if(self.schema[key].unique) {

      // Set the index sort direction, doesn't matter for single key indexes
      index[self.identity+key] = 1;

      // Set the index options
      options.sparse = true;
      options.unique = true;
      options.name = self.identity+key;

      // Store the index in the collection
      self.indexes.push({ index: index, options: options });
      return;
    }

    // Handle non-unique indexes
    if(self.schema[key].index) {

      // Set the index sort direction, doesn't matter for single key indexes
      index[self.identity+key] = 1;

      // Set the index options
      options.sparse = true;
      options.name = self.identity+key;

      // Store the index in the collection
      self.indexes.push({ index: index, options: options });
      return;
    }
  });
};
