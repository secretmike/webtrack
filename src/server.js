var async = require('async');
var http = require('http');
var express = require('express');
var redis = require('redis');
var passport = require('passport');
var PassportLocalStrategy = require('passport-local').Strategy;
var bcrypt = require('bcrypt');
var RedisSessionStore = require('connect-redis')(express);
var flash = require('connect-flash')
var socketio = require('socket.io');


// Connect to redis
var redis_client = redis.createClient();

// Loads a user record from redis
function findByUsername(username, done){
    var key = 'user:' + username;
    redis_client.hgetall(key, function(err, obj){
        if (err){
            done(err);
        }
        else if (!obj){
            done(null, false, {message: "Unknown user"});
        }
        else {
            done(null, obj);
        }
    });
}


// Load all track objects from redis
function getAllTracks(done){
    // Load a sorted list of tracks from redis
    redis_client.sort("tracks", function(err, track_names){
        console.log("getAllTracks SORT: " + err + "," + track_names);
        if(err){
            return done(err);
        }
        // For each track name, load the whole object from redis
        async.map(track_names,
            function(track_name, map_cb){
                redis_client.hgetall(track_name, function(err, track){
                    console.log("getAllTracks HGETALL: " + err + "," + track);
                    map_cb(err, track);
                });
            },
            function(err, tracks){
                console.log("getAllTracks: " + err + "," + tracks);
                if(err){
                    return done(err);
                }
                // Remove any null tracks
                async.filter(tracks,
                    function(track, filter_cb){
                        filter_cb(track !== null);
                    },
                    function(tracks){
                        console.log("getAllTracks:" + tracks);
                        done(null, tracks);
                    });
            });
    });
}

// Load a single track from redis
function getTrackById(id, done){
    var key = "track:" + id;
    var point_key = key + ":points";
    redis_client.hgetall(key, function(err, track){
        console.log("getTrackById: HGETALL: " + err + "," + track);
        if(err){
            done(err);
        }
        else {
            // Load all points for this track
            redis_client.lrange(point_key, 0, -1, function(err, points){
                console.log("getTrackById LRANGE: " + err + "," + points);
                if(err){
                    done(err);
                }
                else{
                    // JSON decode each point
                    async.map(points,
                        function(point, map_cb){
                            console.log("getTrackById json: " + point);
                            try{
                                point = JSON.parse(point);
                                map_cb(null, point);
                            }
                            catch(e){
                                map_cb(e);
                            }
                        },
                        function(err, points){
                            console.log("getTrackById: " + err + "," + points);
                            if(err){
                                done(err);
                            }
                            else{
                                if(track){
                                    track.points = points;
                                }
                                done(null, track);
                            }
                        });
                }
            });
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

// Start listening
var server = app.listen(8000);
console.log('Server listening at http://127.0.0.1:8000/');

// Connect socket.io
io = socketio.listen(server);
io.set('log level', 2);

io.sockets.on('connection', function (socket) {
    console.log("SocketIO Connection");
    socket.on('new point', function (data) {
        console.log("New Point: " + data);
    });
    socket.on('watch track', function(data) {
        console.log("Watch Track: " + data.trackid);
        var track = "track:" + data.trackid;
        socket.join(track);
        socket.broadcast.to(track).emit('new point', {lat: 45.1, lon:45.2});
    });
});






// Set up routes
// Index page
app.get('/', function(req, res) {
    var tracks = [];
    if(req.user){
        getAllTracks(function(err, tracks){
            if(err){
                res.send(500, err);
            }
            else{
                res.render('index', {user: req.user,
                                     tracks: tracks,
                                     flash: req.flash()});
            }
        });
    }
    else {
        res.render('index', {user: req.user,
                             tracks: tracks,
                             flash: req.flash()});
    }
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


// Account Page
app.get('/account', ensureAuthenticated, function(req, res){
    res.render('account', {user: req.user,
                           flash: req.flash()});
});


// Track pages
app.all('/tracks/*', ensureAuthenticated);

app.get('/tracks/:id', function(req, res){
    getTrackById(req.params.id, function(err, track){
        console.log(err, track);
        if(err){
            res.send(500, err);
        }
        else if(!track){
            res.send(404, "Not Found");
        }
        else{
            console.log("Track: " + track);
            res.render('track', {user: req.user,
                                 track: track,
                                 flash: req.flash()});
        }
    });
});


