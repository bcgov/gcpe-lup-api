'use strict';

var _ = require('lodash');
var mongoose = require('mongoose');
var clamav = require('clamav.js');
var fs = require('fs');
var request = require('request');
var turf = require('@turf/turf');
var helpers = require('@turf/helpers');
var Wkt = require('wicket');
const { model } = require('mongoose');
var _serviceHost = process.env.CLAMAV_SERVICE_HOST || '127.0.0.1';
var _servicePort = process.env.CLAMAV_SERVICE_PORT || '3310';
var _tantalisAPI = process.env.TTLS_API_ENDPOINT || 'https://api.nrs.gov.bc.ca/ttls-api/v1/';
var webADEAPI = process.env.WEBADE_AUTH_ENDPOINT || 'https://api.nrs.gov.bc.ca/oauth2/v1/';
var username = process.env.WEBADE_USERNAME || 'TTLS-EXT';
var password = process.env.WEBADE_PASSWORD || 'x';
var MAX_LIMIT = 1000;
var DEFAULT_PAGESIZE = 100;

const getUserProjectPermissions = async function (userSub) {
  const User = mongoose.model('User');
  const user = await User.findOne({ sub: userSub }).exec();
  return user.projectPermissions;
}

exports.getUserProjectPermissions = getUserProjectPermissions;

exports.buildQuery = function (property, values, query) {
  var oids = [];
  if (_.isArray(values)) {
    _.each(values, function (i) {
      oids.push(mongoose.Types.ObjectId(i));
    });
  } else {
    oids.push(mongoose.Types.ObjectId(values));
  }
  return _.assignIn(query, {
    [property]: {
      $in: oids
    }
  });
};

// MBL: TODO Make this event driven instead of synchronous?
exports.avScan = function (buffer) {
  return new Promise(function (resolve, reject) {
    var stream = require('stream');
    // Initiate the source
    var bufferStream = new stream.PassThrough();
    // Write your buffer
    bufferStream.end(buffer);

    clamav.ping(_servicePort, _serviceHost, 1000, function (err) {
      if (err) {
        console.log('ClamAV service: ' + _serviceHost + ':' + _servicePort + ' is not available[' + err + ']');
        resolve(false);
      } else {
        console.log('ClamAV service is alive: ' + _serviceHost + ':' + _servicePort);
        clamav.createScanner(_servicePort, _serviceHost)
          .scan(bufferStream, function (err, object, malicious) {
            if (err) {
              console.log(err);
              resolve(false);
            }
            else if (malicious) {
              console.log('Malicious object FOUND');
              resolve(false);
            }
            else {
              console.log('Virus scan OK');
              resolve(true);
            }
          });
      }
    });
  });
}

exports.getSkipLimitParameters = function (pageSize, pageNum) {
  const params = {};

  var ps = DEFAULT_PAGESIZE; // Default
  if (pageSize && pageSize.value !== undefined) {
    if (pageSize.value > 0) {
      ps = pageSize.value;
    }
  }
  if (pageNum && pageNum.value !== undefined) {
    if (pageNum.value >= 0) {
      params.skip = (pageNum.value * ps);
      params.limit = ps;
    }
  }
  return params;
};

exports.recordAction = async function (action, meta, payload, objId = null) {
  var Audit = mongoose.model('Audit');
  var audit = new Audit({
    _objectSchema: 'Query',
    action: action,
    meta: meta,
    objId: objId,
    performedBy: payload
  });
  return await audit.save();
}

exports.runDataQuery = async function (modelType, role, userSub, query, fields, sortWarmUp, sort, skip, limit, count, preQueryPipelineSteps, populateProponent = false, populateProjectLead = false, populateProjectDirector = false, postQueryPipelineSteps = false, populateProject = false) {
  return new Promise(async function (resolve, reject) {
    let projection = {};
    let projectPermissions = [];
    let projectKey;
    const theModel = mongoose.model(modelType);
    const isUserQuery = modelType === 'User';
    
    projectKey = modelType === 'Project' ? '$_id' : '$project';

    if (modelType === 'EmailSubscribe') {
      projectKey = query.project;
    }

    if (userSub) {
      projectPermissions = await getUserProjectPermissions(userSub)
      .then(permissions => permissions)
      .catch(error => error);
    }

    console.log('populateProponent: ', populateProponent);
    console.log('populateProjectLead: ', populateProjectLead);
    console.log('populateProjectDirector: ', populateProjectDirector);

    // Fields we always return
    var defaultFields = ['_id',
      'code',
      'proponent',
      'tags',
      'read'];

    _.each(defaultFields, function (f) {
      projection[f] = 1;
    });

    // Add requested fields - sanitize first by including only those that we can/want to return
    _.each(fields, function (f) {
      projection[f] = 1;
    });

    var aggregations = _.compact([
      {
        '$match': query
      },
      {
        '$project': projection
      },
      populateProponent && {
        '$lookup': {
          "from": "lup",
          "localField": "proponent",
          "foreignField": "_id",
          "as": "proponent"
        }
      },
      populateProponent && {
        "$unwind": "$proponent"
      },
      populateProjectLead && {
        '$lookup': {
          "from": "lup",
          "localField": "projectLead",
          "foreignField": "_id",
          "as": "projectLead"
        }
      },
      populateProjectLead && {
        "$unwind": {
          "path": "$projectLead",
          "preserveNullAndEmptyArrays": true
        }
      },
      populateProjectDirector && {
        '$lookup': {
          "from": "lup",
          "localField": "projectDirector",
          "foreignField": "_id",
          "as": "projectDirector"
        }
      },
      populateProjectDirector && {
        "$unwind": {
          "path": "$projectDirector",
          "preserveNullAndEmptyArrays": true
        }
      },
      populateProject && {
        '$lookup': {
          "from": "lup",
          "localField": "project",
          "foreignField": "_id",
          "as": "project"
        }
      },
      populateProject && {
        "$unwind": {
          "path": "$project",
          "preserveNullAndEmptyArrays": true
        }
      },
      postQueryPipelineSteps,
      {
        $redact: {
          $cond: {
            if: {
              // This way, if read isn't present, we assume public no roles array.
              $and: [
                {
                  $and: [
                    { $cond: { if: "$read", then: true, else: false } },
                    {
                      $anyElementTrue: {
                        $map: {
                          input: "$read",
                          as: "fieldTag",
                          in: { $setIsSubset: [["$$fieldTag"], role] }
                        }
                      }
                    }
                  ]
                },
                // Check if user either has the create-projects role or has project permissions.
                { $cond: 
                  { if: { $in: [ "public", role ] }, then: true, else:
                    { $cond: 
                      { if: isUserQuery, then: true, else: 
                        { $or: [
                          { $in: [ "create-projects" , role ] },
                          { $in: [ projectKey, projectPermissions ] }
                          ]
                        } 
                      }
                    }
                  }
                }
              ]
            },
            then: "$$KEEP",
            else: {
              $cond: { if: "$read", then: "$$PRUNE", else: "$$DESCEND" }
            }
          }
        }
      },

      sortWarmUp, // Used to setup the sort if a temporary projection is needed.

      !_.isEmpty(sort) ? { $sort: sort } : null,

      sort ? { $project: projection } : null, // Reset the projection just in case the sortWarmUp changed it.

      // Do this only if they ask for it.
      count && {
        $group: {
          _id: null,
          total_items: { $sum: 1 },
          results: { $push: '$$ROOT' }
        }
      },
      count && {
        $project: {
          'total_items': 1,
          'results': {
            $slice: [
              '$results',
              skip,
              limit
            ]
          }
        }
      },
      !count && { $skip: skip || 0 },
      !count && { $limit: limit || MAX_LIMIT }
    ]);

    // Pre-pend the aggregation with other pipeline steps if we are joining on another datasource
    if (preQueryPipelineSteps && preQueryPipelineSteps.length > 0) {
      for (let step of preQueryPipelineSteps) {
        aggregations.unshift(step);
      }
    }

    let collation = {
      locale: 'en',
      strength: 2
    };

    theModel.aggregate(aggregations)
      .collation(collation)
      .exec()
      .then(function(data) {
        resolve(data)
      }, reject);
  });
};
