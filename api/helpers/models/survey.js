const mongoose = require('mongoose');
const surveyQuestion = require('./surveyQuestion').schema;

module.exports = require('../models')('Survey', {
    name                        : { type: String, required: true },
    dateAdded                   : { type: Date, default: Date.now },
    lastSaved                   : { type: Date, default: Date.now },
    project                     : { type: 'ObjectId', ref: 'Project', default: null, index: true },
    commentPeriod               : { type: 'ObjectId', ref: 'CommentPeriod', default: null, index: true },
    questions                   : [surveyQuestion],

    // Permissions
    read                : [{ type: String, trim: true, default: 'sysadmin' }],
    write               : [{ type: String, trim: true, default: 'sysadmin' }],
    delete              : [{ type: String, trim: true, default: 'sysadmin' }]
}, 'lup');