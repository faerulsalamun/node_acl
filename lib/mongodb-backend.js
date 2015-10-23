/**
 MongoDB Backend.
 Implementation of the storage backend using MongoDB
 */
"use strict";

var contract = require('./contract');
var async = require('async');
var _ = require('lodash');

// Name of the collection where meta and allowsXXX are stored.
// If prefix is specified, it will be prepended to this name, like acl_resources
var aclCollectionName = 'resources';

function MongoDBBackend(db, prefix, useSingle) {
    this.db = db;
    this.prefix = typeof prefix !== 'undefined' ? prefix : '';
    this.useSingle = (typeof useSingle !== 'undefined') ? useSingle : false;
}

MongoDBBackend.prototype = {
    /**
     Begins a transaction.
     */
    begin: function () {
        // returns a transaction object(just an array of functions will do here.)
        return [];
    },

    /**
     Ends a transaction (and executes it)
     */
    end: function (transaction, cb) {
        contract(arguments).params('array', 'function').end();
        async.series(transaction, function (err) {
            cb(err instanceof Error ? err : undefined);
        });
    },

    /**
     Cleans the whole storage.
     */
    clean: function (cb) {
        contract(arguments).params('function').end();
        this.db.collections(function (err, collections) {
            if (err instanceof Error) return cb(err);
            async.forEach(collections, function (coll, innercb) {
                coll.drop(function () {
                    innercb()
                }); // ignores errors
            }, cb);
        });
    },

    /**
     Gets the contents at the bucket's username.
     */
    get: function (bucket, id, cb) {
        contract(arguments)
            .params('string', 'string|number', 'function')
            .end();
        id = encodeText(id);
        var searchParams = (this.useSingle ? {_bucketname: bucket, _id: ObjectID(id)} : {_id: ObjectID(id)});
        var collName = (this.useSingle ? aclCollectionName : bucket);

        this.db.collection(this.prefix + collName, function (err, collection) {
            if (err instanceof Error) return cb(err);
            // Excluding bucket field from search result
            collection.findOne(searchParams, {_bucketname: 0}, function (err, doc) {
                if (err) return cb(err);
                if (!_.isObject(doc.roles)) return cb(undefined, []);
                doc.roles = fixKeys(doc.roles);
                cb(undefined, _.without(_.keys(doc.roles), "username", "_id"));
            });
        });
    },

    /**
     Returns the union of the values in the given keys.
     */
    union: function (bucket, keys, cb) {
        contract(arguments)
            .params('string', 'array', 'function')
            .end();
        keys = encodeAll(keys);
        var searchParams = (this.useSingle ? {_bucketname: bucket, username: {$in: keys}} : {username: {$in: keys}});
        var collName = (this.useSingle ? aclCollectionName : bucket);

        this.db.collection(this.prefix + collName, function (err, collection) {
            if (err instanceof Error) return cb(err);
            // Excluding bucket field from search result
            collection.find(searchParams, {_bucketname: 0}).toArray(function (err, docs) {
                if (err instanceof Error) return cb(err);
                if (!docs.length) return cb(undefined, []);
                var keyArrays = [];
                docs = fixAllKeys(docs);
                docs.forEach(function (doc) {
                    keyArrays.push.apply(keyArrays, _.keys(doc));
                });
                cb(undefined, _.without(_.union(keyArrays), "username", "_id"));
            });
        });
    },

    /**
     Adds values to a given username inside a bucket.
     */
    add: function (transaction, bucket, username, values) {
        contract(arguments)
            .params('array', 'string', 'string|number', 'string|array|number')
            .end();

        if (username == "username") throw new Error("Key name 'username' is not allowed.");
        username = encodeText(username);
        var self = this;
        var updateParams = (self.useSingle ? {_bucketname: bucket, username: username} : {username: username});
        var collName = (self.useSingle ? aclCollectionName : bucket);

        transaction.push(function (cb) {
            values = makeArray(values);
            self.db.collection(self.prefix + collName, function (err, collection) {
                if (err instanceof Error) return cb(err);

                // build doc from array values
                var doc = {};
                values.forEach(function (value) {
                    doc[value] = true;
                });

                // update document
                collection.update(updateParams, {$set: doc}, {safe: true, upsert: true}, function (err) {
                    if (err instanceof Error) return cb(err);
                    cb(undefined);
                });
            });
        });

        transaction.push(function (cb) {
            self.db.collection(self.prefix + collName, function (err, collection) {
                // Create index
                collection.ensureIndex({_bucketname: 1, username: 1}, function (err) {
                    if (err instanceof Error) {
                        return cb(err);
                    } else {
                        cb(undefined);
                    }
                });
            });
        })
    },

    /**
     Delete the given key(s) at the bucket
     */
    del: function (transaction, bucket, username) {
        contract(arguments)
            .params('array', 'string', 'string|array')
            .end();
        username = makeArray(username);
        var self = this;
        var updateParams = (self.useSingle ? {
            _bucketname: bucket,
            username: {$in: username}
        } : {username: {$in: keys}});
        var collName = (self.useSingle ? aclCollectionName : bucket);

        transaction.push(function (cb) {
            self.db.collection(self.prefix + collName, function (err, collection) {
                if (err instanceof Error) return cb(err);
                collection.remove(updateParams, {safe: true}, function (err) {
                    if (err instanceof Error) return cb(err);
                    cb(undefined);
                });
            });
        });
    },

    /**
     Removes values from a given username inside a bucket.
     */
    remove: function (transaction, username, key, values) {
        contract(arguments)
            .params('array', 'string', 'string|number', 'string|array|number')
            .end();
        username = encodeText(username);
        var self = this;
        var updateParams = (self.useSingle ? {_bucketname: bucket, username: username} : {username: username});
        var collName = (self.useSingle ? aclCollectionName : bucket);

        values = makeArray(values);
        transaction.push(function (cb) {
            self.db.collection(self.prefix + collName, function (err, collection) {
                if (err instanceof Error) return cb(err);

                // build doc from array values
                var doc = {};
                values.forEach(function (value) {
                    doc[value] = true;
                });

                // update document
                collection.update(updateParams, {$unset: doc}, {safe: true, upsert: true}, function (err) {
                    if (err instanceof Error) return cb(err);
                    cb(undefined);
                });
            });
        });
    }
}

function encodeText(text) {
    if (typeof text == 'string' || text instanceof String) {
        text = encodeURIComponent(text);
        text = text.replace(/\./g, '%2E');
    }
    return text;
}

function decodeText(text) {
    if (typeof text == 'string' || text instanceof String) {
        text = decodeURIComponent(text);
    }
    return text;
}

function encodeAll(arr) {
    if (Array.isArray(arr)) {
        var ret = [];
        arr.forEach(function (aval) {
            ret.push(encodeText(aval));
        });
        return ret;
    } else {
        return arr;
    }
}

function decodeAll(arr) {
    if (Array.isArray(arr)) {
        var ret = [];
        arr.forEach(function (aval) {
            ret.push(decodeText(aval));
        });
        return ret;
    } else {
        return arr;
    }
}

function fixKeys(doc) {
    if (doc) {
        var ret = {};
        for (var username in doc) {
            if (doc.hasOwnProperty(username)) {
                ret[decodeText(username)] = doc[username];
            }
        }
        return ret;
    } else {
        return doc;
    }
}

function fixAllKeys(docs) {
    if (docs && docs.length) {
        var ret = [];
        docs.forEach(function (adoc) {
            ret.push(fixKeys(adoc));
        });
        return ret;
    } else {
        return docs;
    }
}

function makeArray(arr) {
    return Array.isArray(arr) ? encodeAll(arr) : [encodeText(arr)];
}

exports = module.exports = MongoDBBackend;
