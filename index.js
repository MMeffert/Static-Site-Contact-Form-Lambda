var AWS = require('aws-sdk');
var ses = new AWS.SES();

var SENDER = 'SENDER_EMAIL_ADDRESS';
var RECEIVER = 'RECEIVER_EMAIL_ADDRESS';
var SUBJECT = "EMAIL_SUBJECT";

var response = {
 "isBase64Encoded": false,
 "headers": { 'Content-Type': 'application/json'},
 "statusCode": 200,
 "body": "{\"result\": \"Success.\"}"
 };

exports.handler = function (event, context) {
    console.log('Received event:', event);
    sendEmail(event, function (err, data) {
        context.done(err, null);
    });
};
 
function sendEmail (event, done) {
    var params = {
        Destination: {
            ToAddresses: [
                RECEIVER
            ]
        },
        Message: {
            Body: {
                Text: {
                    Data: 'From: ' + event.name + '\n\nFrom Email: ' + event.email + '\n\nSubject: ' + event.subject + '\n\nComments: ' + event.message,
                    Charset: 'UTF-8'
                }
            },
            Subject: {
                Data: SUBJECT,
                Charset: 'UTF-8'
            }
        },
        Source: SENDER
    };
    ses.sendEmail(params, done);
}
