const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const knexConfig = require('./knexfile');
const knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development']);
const { Model } = require('objection'); // ValidationError
const Users = require('./models/Users');
const session = require('express-session');
const passport = require('passport');
const BearerStrategy = require('passport-http-bearer').Strategy;
const { OAuth2Client } = require('google-auth-library');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Bind all Models to a knex instance.
Model.knex(knex);

// db-errors provides a consistent wrapper around database errors
const { wrapError, DBError } = require('db-errors');

const app = express();

// express only serves static assets in production
if (process.env.NODE_ENV === 'production') {
  // Resolve client build directory as absolute path to avoid errors in express
  const path = require('path'); // eslint-disable-line global-require
  const buildPath = path.resolve(__dirname, '../client/build');

  app.use(express.static(buildPath));

  // Serve the HTML file included in the CRA client on the root path
  app.get('/', (request, response) => {
    response.sendFile(path.join(buildPath, 'index.html'));
  });
}

// Cross-Origin-Resource-Sharing headers tell the browser is OK for this page to request resources
// from another domain (which is otherwise prohibited as a security mechanism)
const corsOptions = {
  methods: ['GET', 'PUT', 'POST', 'DELETE'],
  origin: '*',
  allowedHeaders: ['Content-Type', 'Accept', 'X-Requested-With', 'Origin']
};

app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(
  session({
    secret: '109482dnijfn9234',
    resave: false,
    saveUninitialized: false
  })
);
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  Users.query()
    .findOne('id', id)
    .then(user => {
      done(null, user);
    });
});

// const authenticationMiddleware = (request, response, next) => {
//   if (request.isAuthenticated()){
//     return next(); // we are good, proceed to the next handler
//   }
//   return response.sendStatus(403); // forbidden
// };

passport.use(
  new BearerStrategy((token, done) => {
    googleClient
      .verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID
      })
      .then(async ticket => {
        const payload = ticket.getPayload();
        let user = await Users.query().findOne('googleId', payload.sub);
        if (!user) {
          user = await Users.query().insertAndFetch({
            googleId: payload.sub,
            givenName: payload.given_name,
            email: payload.email,
            total_games: 0,
            total_multi_games: 0,
            total_multi_wins: 0,
            map_1: -1
          });
        }
        done(null, user);
      })
      .catch(error => {
        done(error);
      });
  })
);

// Google login
app.post(
  '/login',
  passport.authenticate('bearer', { session: true }),
  (request, response, next) => {
    console.log(request.isAuthenticated(), request.session);
    response.sendStatus(200);
  }
);

// authenticationMiddleware,
app.put(
  '/api/users/',

  (request, response, next) => {
    const { contents } = request.body.contents;
    const { type } = request.body.type;

    if (type === 'end') {
      (async () => {
        const user = await Users.query().findById(request.user.id);
        console.log(user, contents, type);
        if (user.map_1 === -1 || user.map_1 > contents.time) {
          // REPLACE WITH GENERICCC
          user
            .$query()
            .patchAndFetch({
              map_1: contents.time,
              total_games: user.total_games + 1
            })
            .then(rows => {
              response.send(rows);
            }, next);
        }
      })();
    }
  }
);

// Simple error handler.
app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error);
  }

  /*
   * Do not want to send information about the inner workings of the
   * database to the client.
   */
  if (process.env.NODE_ENV !== 'production') {
    const wrappedError = wrapError(error);
    if (wrappedError instanceof DBError) {
      response
        .status(400)
        .send(wrappedError.data || wrappedError.message || {});
    } else {
      response
        .status(wrappedError.statusCode || wrappedError.status || 500)
        .send(wrappedError.data || wrappedError.message || {});
    }
  }
});

module.exports = {
  app,
  knex
};
