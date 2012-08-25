var express = require('express');
var passport = require('passport');
var PassportLocalStrategy = require('passport-local').Strategy;
var flash = require('connect-flash')
//var io = require('socket.io');



var users = [
    {id: 1, username: 'mike', password: 'password', email: 'mike@example.com'},
    {id: 2, username: 'joe', password: 'password', email: 'joe@example.com'}
];

function findById(id, done){
    var idx = id - 1;
    if (users[idx]) {
        done(null, users[idx]);
    }
    else {
        done(new Error('User ' + id + ' does not exist'));
    }
}

function findByUsername(username, done){
    for (var i = 0, len = users.length; i < len; i++) {
        var user = users[i];
        if (user.username === username) {
            return done(null, user);
        }
    }
    return done(null, null);
}


passport.serializeUser(function(user, done){
    done(null, user.id);
});

passport.deserializeUser(function(id, done) {
    findById(id, function(err, user){
        done(err, user);
    });
});





passport.use(new PassportLocalStrategy(function(username, password, done) {
    // asynchronous verification, for effect...
    process.nextTick(function(){
        // Find the user by username.  If there is no user with the given
        // username, or the password is not correct, set the user to `false` to
        // indicate failure and set a flash message.  Otherwise, return the
        // authenticated `user`.
        findByUsername(username, function(err, user){
            if (err){ return done(err); }
            if (!user){ return done(null, false, {message: 'Unknown user ' + username}); }
            if (user.password != password){ return done(null, false, { message: 'Invalid password' }); }
            return done(null, user);
        })
    });
}));


// Simple route middleware to ensure user is authenticated.
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) { return next(); }
  res.redirect('/login');
}


var app = express();

// Configure app
app.set('views', __dirname + '/views');
app.set('view engine', 'jade');
//app.set('view options', {layout: true});

// Set up middleware
app.use(express.responseTime());
app.use(express.logger());
app.use(express.favicon());
app.use(express.cookieParser());
app.use(express.bodyParser());
app.use(express.session({secret: "BadWolf"}));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());
app.use(app.router);
app.use(express.static(__dirname + '/public'));


// Set up routes
// Index page
app.get('/', function(req, res) {
    res.render('index', {user: req.user,
                         flash: req.flash()});
});


// Account Page
app.get('/account', ensureAuthenticated, function(req, res){
    res.render('account', {user: req.user,
                           flash: req.flash()});
});


// Login/Logout pages
app.get('/login', function(req, res){
    res.render('login', {user: req.user,
                         flash: req.flash()});
});

app.post('/login', 
    passport.authenticate('local', {failureRedirect: '/login',
                                    failureFlash: true,
                                    successFlash: "Login Successful"}),
    function(req, res) {
        res.redirect('/');
    });

app.get('/logout', function(req, res){
    req.logout();
    res.redirect('/');
});


// Start listening
app.listen(8000);
console.log('Server listening at http://127.0.0.1:8000/');
