var express = require('express');
var redis = require('redis');
var passport = require('passport');
var PassportLocalStrategy = require('passport-local').Strategy;
var bcrypt = require('bcrypt');
var RedisSessionStore = require('connect-redis')(express);
var flash = require('connect-flash')
//var io = require('socket.io');


// Connect to redis
var redis_client = redis.createClient();

// Loads a user record from redis
function findByUsername(username, done){
    var key = 'user:' + username;
    redis_client.hgetall(key, function(err, obj){
        if (err){
            done(err);
        }
        if (!obj){
            done(null, false, {message: "Unknown user"});
        }
        else {
            done(null, obj);
        }
    });
}

// Serialize a user into something that can be stored in a session
// In this case we load the user from redis so we only need to keep
// the username as a unique key
passport.serializeUser(function(user, done){
    done(null, user.username);
});

// Deserialize a user based on the username. In this case we're storing
// the user in redis so we just load the user based on the username.
passport.deserializeUser(function(username, done) {
    findByUsername(username, function(err, user){
        // Copy the username into the id field to keep passport happy.
        user.id = user.username;
        done(err, user);
    });
});

// Configure the passport strategy to authenticate based on locally
// stored user records.
passport.use(new PassportLocalStrategy(function(username, password, done) {
    // Find the user by username.  If there is no user with the given
    // username, or the password is not correct, set the user to `false` to
    // indicate failure and set a flash message.  Otherwise, return the
    // authenticated `user`.
    findByUsername(username, function(err, user){
        if (err){
            return done(err);
        }
        if (!user){
            return done(null, false, {message: 'Unknown user ' + username});
        }

        bcrypt.compare(password, user.passhash, function(err, res) {
            if (res) {
                //success
                return done(null, user);
            }
            else {
                //failure
                return done(null, false, {message: 'Invalid password'});
            }
        });
    });
}));


// Simple route middleware to ensure user is authenticated.
function ensureAuthenticated(req, res, next){
    if (req.isAuthenticated()){
        return next();
    }
    res.redirect('/login');
}


// Configure app
var app = express();
app.set('views', __dirname + '/views');
app.set('view engine', 'jade');

// Set up middleware
app.use(express.responseTime());
app.use(express.logger());
app.use(express.favicon());
app.use(express.cookieParser());
app.use(express.bodyParser());
app.use(express.session({store: new RedisSessionStore({ttl: 60 * 30}),
                         secret: "BadWolf"}));
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
