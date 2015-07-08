'use strict';



var args =  process.argv;
var to = args[2];
var message = args[3];
var sock = require('net').connect('/tmp/muttrd-svc.sock');
var util = require('util');

if (!to || !message) {
  console.log('Usage: node sendmsg.js <to> <message>');
  console.log('Example: node sendmsg.js "gordon@muttr.me" "hello, friend!"');
  process.exit();
}

console.log('Sending message: "%s" to %s...', message, to);

sock.on('data', function(data) {
  console.log(util.inspect(JSON.parse(data.toString()), { depth: null }));
});

sock.write(JSON.stringify({
  type: 'send',
  body: { to: to, message: message }
}) + '\n');
