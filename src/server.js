var express = require('express');
var io = require('socket.io');
var http = require('http');

var app = express();

// Set up middleware
app.use(express.responseTime());
app.use(express.logger());
app.use(express.favicon());
app.use(express.static(__dirname + '/public'));
app.use(express.cookieParser());
app.use(express.session({secret: "BadWolf"}));

// Set up routes
app.get('/', function(req, res) {
    res.send('Hello World');
});

// Start listening
app.listen(8000);
console.log('Server listening at http://127.0.0.1:8000/');
