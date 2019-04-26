import React, { Component } from 'react';
import Map from './Map.js';
import PauseMenu from './PauseMenu.js';
import ChangeKeyMenu from './ChangeKeyMenu.js';
import ProgressBar from './ProgressBar.js';
import { findMapSpan, buildMapHashtable } from './mapParser.js';
import Timer from './Timer.js';
import Tutorial from './Tutorial.js';
import styled from 'styled-components';
import request from 'request-promise-native';
// for client socket
import io from 'socket.io-client';

const SVGLayer = styled.svg`
  position: absolute;
`;

// Jump state enum for clarity
const jump = {
  STOP: 0,
  UP: 1,
  DOWN: 2
};

// time between updates sent to the server
const UPDATE_INTERVAL = 40; // milliseconds

const TOOLBAR_Y = 15;
const UPDATE_TIMEOUT = 20; // time between motionChange updates
const RENDER_TIMEOUT = 20; // time between rerenders
const JUMP_SPEED = 0.0013; // acceleration
const JUMP_POWER = 0.7; // jumping velocity
const SCROLL_SPEED = 0.4;
const SPRITE_SIDE = 100;
const PATH_THRESH = 5;
const TIME_THRESH = RENDER_TIMEOUT;

const INITIAL_STATE = {
  tutorial: false,
  paused: false,
  gameover: false,
  jumpKey: 32, // space bar
  startKey: 115, // s key
  changingKey: false,

  y: 350,
  mapTranslation: 0,

  windowWidth: window.innerWidth,
  windowHeight: window.innerHeight,
  players: undefined,
  color: `rgb(${Math.random() * 255},${Math.random() * 255},${Math.random() *
    255})`
};

const INITIAL_VARIABLES = {
  gameStartTime: undefined,

  x: 200,
  minY: 1000, // should loop over all of map or whatever to find this.

  // will take an object of the following form {time: , event: } options for event are block, go, land, and fall
  motionChange: undefined,

  yStart: INITIAL_STATE.y,
  jumpState: jump.STOP,
  jumpStartTime: undefined,
  descendStartTime: undefined,

  mapTranslationStart: 0,
  atWall: false,
  mapTranslationStartTime: undefined,

  pauseOffsetStart: undefined,
  timePaused: 0
};

class GameEngine extends Component {
  constructor(props) {
    super(props);

    this.state = Object.assign(
      {},
      INITIAL_STATE,
      { user: this.props.user },
      { map: this.props.mapName }
    );
    this.variables = Object.assign({}, INITIAL_VARIABLES);

    /*
     * each game will have a socket to connect back to the server
     * store the other players as a member for THIS player
     */
    this.socket = io.connect();

    this.timeout = null;
    this.renderInterval = null;
    this.updateInterval = null;

    this.mapLength = findMapSpan(this.props.mapProps.map);
    this.map = buildMapHashtable(
      this.mapLength,
      this.props.mapProps.strokeWidth,
      this.props.mapProps.map
    );

    this.debounce = this.debounce.bind(this);
    this.handleKeyPress = this.handleKeyPress.bind(this);
    this.handleJumpKey = this.handleJumpKey.bind(this);
    this.handleChangeJumpKey = this.handleChangeJumpKey.bind(this);
    this.handleWindowResize = this.handleWindowResize.bind(this);
    this.restartGame = this.restartGame.bind(this);
    this.resumeGame = this.resumeGame.bind(this);
    this.pauseGame = this.pauseGame.bind(this);
    this.endGame = this.endGame.bind(this);
    this.findWall = this.findWall.bind(this);
    this.findPath = this.findPath.bind(this);
    this.findEndOfPath = this.findEndOfPath.bind(this);
    this.checkAtWall = this.checkAtWall.bind(this);
    this.getTimeForGivenY = this.getTimeForGivenY.bind(this);
    this.getTimeForGivenX = this.getTimeForGivenX.bind(this);
    this.getX = this.getX.bind(this);
    this.getMapTranslation = this.getMapTranslation.bind(this);
    this.getY = this.getY.bind(this);
    this.spriteAtWall = this.spriteAtWall.bind(this);
    this.spriteOnFlat = this.spriteOnFlat.bind(this);
    this.spriteGoingUp = this.spriteGoingUp.bind(this);
    this.spriteGoingDown = this.spriteGoingDown.bind(this);
    this.findNextChange = this.findNextChange.bind(this);
    this.startLoops = this.startLoops.bind(this);
    this.exitToMenu = this.exitToMenu.bind(this);
  }

  /*
   * Prevent functions from event handlers from being repeatedly called.
   * This is essential for on window resize, which could potentially be called
   * a ton.
   *
   * Params: func: function to debounce
   *         delay: how long to wait after the last call until we fire func
   *         ...args: func's arguements
   */
  debounce(func, delay, ...args) {
    return () => {
      const fireLater = () => {
        func(...args);
      };

      clearTimeout(this.timeout);
      this.timeout = setTimeout(fireLater, delay);
    };
  }

  // Initiates jump
  handleJumpKey() {
    this.variables.yStart = this.getY();
    this.variables.jumpState = jump.UP;
    this.variables.jumpStartTime = new Date().getTime();
    this.variables.motionChange = undefined;
    (async () => {
      this.variables.motionChange = this.findNextChange();
    })();
  }

  // Changes our current jump key
  handleChangeJumpKey(event) {
    this.setState({ jumpKey: event.keyCode, changingKey: false });
  }

  /*
   * Allows the character to jump when spacebar is pressed and prevents the
   * character from jumping mid-jump
   */
  handleKeyPress(event) {
    if (this.state.changingKey) {
      this.handleChangeJumpKey(event);
    } else if (
      event.keyCode === this.state.jumpKey &&
      this.variables.jumpState === jump.STOP &&
      !this.state.paused &&
      this.variables.gameStartTime
    ) {
      this.handleJumpKey();
    } else if (
      !this.variables.gameStartTime &&
      event.keyCode === this.state.startKey
    ) {
      this.startLoops();
    } else {
      void 0; // do nothing
    }
  }

  // Resets our current window dimentions
  handleWindowResize() {
    this.setState({
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight
    });
  }

  // restarts the game
  restartGame() {
    // clear loops
    clearInterval(this.updateInterval);
    clearInterval(this.renderInterval);

    /*
     * make sure window is correct size
     * (person may have changes window while playing so can't really make a default for it)
     */
    const restartState = Object.assign({}, INITIAL_STATE, {
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight
    });
    this.setState(restartState);
    this.variables = Object.assign(this.variables, INITIAL_VARIABLES);
  }

  // resumes the game after being paused
  resumeGame() {
    const timeElapsed = new Date().getTime() - this.variables.pauseOffsetStart;

    // add the time elapsed to every relevant time
    this.variables.timePaused = this.variables.timePaused + timeElapsed;
    this.variables.mapTranslationStartTime =
      this.variables.mapTranslationStartTime + timeElapsed;
    this.variables.jumpStartTime = this.variables.jumpStartTime + timeElapsed;
    this.variables.descendStartTime =
      this.variables.descendStartTime + timeElapsed;
    if (this.variables.motionChange) {
      this.variables.motionChange.time =
        this.variables.motionChange.time + timeElapsed;
    }
    this.setState({
      paused: false
    });
  }

  // pauses the game
  pauseGame() {
    if (this.variables.gameStartTime) {
      this.variables.pauseOffsetStart = new Date().getTime();
      this.setState({
        paused: true
      });
    } else {
      void 0; // don't pause if we haven't started
    }
  }

  // I'm pretty sure this should just be in the componentDidUnmount lifecycle function
  // exits to main menu
  exitToMenu() {
    this.timeout = null;
    clearInterval(this.updateInterval);
    clearInterval(this.renderInterval);

    // resetting temporary variables
    this.mapTranslation = INITIAL_STATE.mapTranslation;
    this.y = INITIAL_STATE.y;
    const restartState = Object.assign({}, INITIAL_STATE, {
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight
    });
    this.setState(restartState);

    this.props.goToMenu();
  }
  // set gameover flag
  endGame() {
    const user = this.state.user;
    if (
      this.state.username !== 'guest' // exclusive to guest account
    ) {
      const options = {
        url:
          (process.env.NODE_ENV === 'development'
            ? 'http://localhost:3000'
            : 'https://rollrace.herokuapp.com') +
          `/api/users/:${this.state.user.id}`,
        body: {
          type: 'end',
          contents: {
            id: user.id,
            time: parseInt(
              (new Date().getTime() -
                this.variables.gameStartTime +
                this.variables.timePaused) /
                1000
            )
          }
        },
        json: true
      };
      request
        .put(options)
        .then(resp => {
          // console.log(resp)  // for debugging
          this.pauseGame();
          this.setState({
            gameover: true,
            user: resp
          });
        })
        .catch(err => console.log(err));
    }
  }

  // detects a future wall and returns the time of collision
  findWall(props) {
    // define local variables
    const {
      mapTranslation,
      mapTranslationStart,
      mapTranslationStartTime,
      maxX,
      descendStartTime,
      jumpStartTime,
      jumpState,
      yStart,
      y,
      atWall
    } = props;

    let currentX = Math.round(
      this.variables.x +
        SPRITE_SIDE -
        this.props.mapProps.strokeWidth -
        mapTranslation
    );

    for (currentX; currentX <= maxX; currentX++) {
      const locations = this.map[currentX];
      for (let j = 0; j < locations.length; j++) {
        const newY = this.getY({
          currentTime: this.getTimeForGivenX({
            mapTranslationStart: mapTranslationStart,
            mapTranslationStartTime: mapTranslationStartTime,
            atWall: atWall,
            x: currentX - SPRITE_SIDE
          }),
          descendStartTime: descendStartTime,
          jumpStartTime: jumpStartTime,
          jumpState: jumpState,
          yStart: yStart,
          y: y
        });

        if (locations[j][0] === 'b' && this.checkAtWall(locations[j], newY)) {
          return {
            time: this.getTimeForGivenX({
              mapTranslationStart: mapTranslationStart,
              mapTranslationStartTime: mapTranslationStartTime,
              atWall: atWall,
              x: currentX - SPRITE_SIDE
            }),
            event: 'block'
          };
        }
      }
    }
    return undefined;
  }

  // detects a future path and returns the time of landing
  findPath(props) {
    // declare local variables
    const {
      currentTime,
      mapTranslationStart,
      mapTranslationStartTime,
      mapTranslation,
      atWall,
      yStart,
      descendStartTime,
      jumpState,
      jumpStartTime,
      maxX
    } = props;

    let currentX = Math.round(this.variables.x - mapTranslation);
    let highest = this.variables.minY;

    for (currentX; currentX <= maxX; currentX++) {
      const locations = this.map[currentX];
      for (let j = 0; j < locations.length; j++) {
        if (
          locations[j][0] === 'h' &&
          locations[j][1] - SPRITE_SIDE < highest
        ) {
          const time = this.getTimeForGivenY({
            yStart: yStart,
            y: locations[j][1] - SPRITE_SIDE,
            descendStartTime: descendStartTime,
            jumpState: jumpState,
            jumpStartTime: jumpStartTime,
            currentTime: currentTime
          });
          const xBack = this.getX({
            currentTime: time,
            mapTranslationStart: mapTranslationStart,
            mapTranslationStartTime: mapTranslationStartTime,
            mapTranslation: mapTranslation,
            atWall: atWall
          });
          const xFront = xBack + SPRITE_SIDE;
          if (xBack <= currentX && currentX <= xFront) {
            highest = locations[j][1] - SPRITE_SIDE;
          }
        }
      }
    }

    if (highest !== this.variables.minY) {
      // if path found
      return {
        time: this.getTimeForGivenY({
          yStart: yStart,
          y: highest,
          descendStartTime: descendStartTime,
          jumpState: jumpState,
          jumpStartTime: jumpStartTime,
          currentTime: currentTime
        }),
        event: 'land',
        y: highest
      };
    } else {
      // no path found
      return undefined;
    }
  }

  // detects the end of the current path and returns the time of arrival
  findEndOfPath(props) {
    // declare local variables
    const {
      mapTranslation,
      y,
      mapTranslationStart,
      mapTranslationStartTime,
      atWall
    } = props;

    let currentX = Math.round(this.variables.x - mapTranslation);
    let foundPath = false; // whether or not we have found the start of the current path

    for (currentX; currentX <= this.mapLength; currentX++) {
      const locations = this.map[currentX];
      let found = false;
      for (let j = 0; j < locations.length; j++) {
        if (
          !foundPath &&
          Math.abs(locations[j][1] - (y + SPRITE_SIDE)) < PATH_THRESH
        ) {
          foundPath = true;
        }
        if (
          locations[j][0] === 'b' ||
          (locations[j][0] === 'h' &&
            Math.abs(locations[j][1] - (y + SPRITE_SIDE)) < PATH_THRESH) ||
          !foundPath
        ) {
          found = true;
        }
      }
      if (!found) {
        return {
          time: this.getTimeForGivenX({
            mapTranslationStart: mapTranslationStart,
            mapTranslationStartTime: mapTranslationStartTime,
            atWall: atWall,
            x: currentX
          }),
          event: 'fall'
        };
      }
    }
    return undefined;
  }

  // checks to see if a given y value matches a wall
  checkAtWall(location, y) {
    if (
      location[0] === 'b' &&
      ((location[1] <= y && y <= location[2]) ||
        (location[1] <= y + SPRITE_SIDE && y + SPRITE_SIDE <= location[2]))
    ) {
      return true;
    }
    return false;
  }

  /*
   * return the time when the sprite will reach the given y value also given the state of the game
   * comes from solving the distance function in getY for time
   */
  getTimeForGivenY(props) {
    if (props.jumpState === jump.DOWN) {
      return (
        Math.sqrt((-props.yStart + props.y) / (0.5 * JUMP_SPEED)) +
        props.descendStartTime
      );
    } else if (props.jumpState === jump.UP) {
      return (
        (-Math.sqrt(
          JUMP_POWER ** 2 +
            2 * props.y * JUMP_SPEED -
            2 * JUMP_SPEED * props.yStart
        ) +
          JUMP_POWER +
          props.jumpStartTime * JUMP_SPEED) /
        JUMP_SPEED
      );
    } else {
      console.log('returning undefined');
      return undefined;
    }
  }

  /*
   * return the time when the sprite will reach the given x value also given the state of the game
   * comes from solving the distance function in getX for time
   */
  getTimeForGivenX(props) {
    if (props.atWall) {
      console.log('return undefined');
      return undefined;
    } else {
      return (
        (props.mapTranslationStart - (this.variables.x - props.x)) /
          SCROLL_SPEED +
        props.mapTranslationStartTime
      );
    }
  }

  // return the x value of the sprite given current state of the game
  getX(
    props = {
      currentTime: new Date().getTime(),
      mapTranslationStart: this.variables.mapTranslationStart,
      mapTranslationStartTime: this.variables.mapTranslationStartTime,
      mapTranslation: this.state.mapTranslation,
      atWall: this.variables.atWall
    }
  ) {
    return (
      this.variables.x -
      this.getMapTranslation({
        currentTime: props.currentTime,
        mapTranslationStart: props.mapTranslationStart,
        mapTranslationStartTime: props.mapTranslationStartTime,
        mapTranslation: props.mapTranslation,
        atWall: props.atWall
      })
    );
  }

  // return the mapTranslation value given current state of the game
  getMapTranslation(
    props = {
      currentTime: new Date().getTime(),
      mapTranslationStart: this.variables.mapTranslationStart,
      mapTranslationStartTime: this.variables.mapTranslationStartTime,
      mapTranslation: this.state.mapTranslation,
      atWall: this.variables.atWall
    }
  ) {
    if (props.atWall || this.state.paused) {
      return this.state.mapTranslation;
    } else {
      return (
        props.mapTranslationStart -
        (props.currentTime - props.mapTranslationStartTime) * SCROLL_SPEED
      );
    }
  }

  // return the y value of the sprite given current state of the game
  getY(
    props = {
      currentTime: new Date().getTime(),
      descendStartTime: this.variables.descendStartTime,
      jumpStartTime: this.variables.jumpStartTime,
      jumpState: this.variables.jumpState,
      yStart: this.variables.yStart,
      y: this.state.y
    }
  ) {
    if (props.jumpState === jump.STOP || this.state.paused) {
      return props.y;
    } else if (props.jumpState === jump.DOWN) {
      return (
        props.yStart +
        0.5 * (props.currentTime - props.descendStartTime) ** 2 * JUMP_SPEED
      );
    } else if (props.jumpState === jump.UP) {
      return (
        props.yStart -
        ((props.currentTime - props.jumpStartTime) * JUMP_POWER -
          0.5 * (props.currentTime - props.jumpStartTime) ** 2 * JUMP_SPEED)
      );
    }
  }

  // determines what should happen when the sprite is stuck at a wall
  spriteAtWall(props) {
    // declare local variables
    const {
      currentTime,
      y,
      mapTranslation,
      yStart,
      descendStartTime,
      jumpState,
      jumpStartTime,
      atWall,
      mapTranslationStart,
      mapTranslationStartTime
    } = props;

    let currentX = Math.round(this.variables.x - mapTranslation);
    let found = false;
    let wall;
    while (!found) {
      const locations = this.map[currentX];
      for (let j = 0; j < locations.length; j++) {
        // need to add a case where there are two wall with the same x value
        if (locations[j][0] === 'b') {
          wall = locations[j];
          found = true;
        }
      }
      currentX++;
    }

    if (jumpState === jump.UP) {
      const peakTime = JUMP_POWER / JUMP_SPEED + jumpStartTime;
      if (
        this.getY({
          currentTime: peakTime,
          descendStartTime: descendStartTime,
          jumpStartTime: jumpStartTime,
          jumpState: jumpState,
          yStart: yStart,
          y: y
        }) >
        wall[1] - SPRITE_SIDE
      ) {
        return { time: peakTime, event: 'fall' };
      } else {
        return {
          time: this.getTimeForGivenY({
            yStart: yStart,
            y: wall[1] - SPRITE_SIDE,
            descendStartTime: descendStartTime,
            jumpState: jumpState,
            jumpStartTime: jumpStartTime,
            currentTime: currentTime
          }),
          event: 'go'
        };
      }
    }
    // (this.jumpState === jump.DOWN)
    else {
      const timeToEscape = {
        time: this.getTimeForGivenY({
          yStart: yStart,
          y: wall[2],
          descendStartTime: descendStartTime,
          jumpState: jumpState,
          jumpStartTime: jumpStartTime,
          currentTime: currentTime
        }),
        event: 'go'
      };
      const timeToLand = this.findPath({
        currentTime: currentTime,
        mapTranslationStart: mapTranslationStart,
        mapTranslationStartTime: mapTranslationStartTime,
        mapTranslation: mapTranslation,
        atWall: atWall,
        yStart: yStart,
        descendStartTime: descendStartTime,
        jumpState: jumpState,
        jumpStartTime: jumpStartTime,
        maxX: currentX + SPRITE_SIDE
      });
      if (!timeToLand || timeToLand.time > timeToEscape.time) {
        return timeToEscape;
      } else {
        return timeToLand;
      }
    }
  }

  // determines what should happen when the sprite is moving along a path
  spriteOnFlat(props) {
    // declare local variables
    const {
      y,
      mapTranslation,
      yStart,
      descendStartTime,
      jumpState,
      jumpStartTime,
      atWall,
      mapTranslationStart,
      mapTranslationStartTime
    } = props;
    const endOfPath = this.findEndOfPath({
      mapTranslation: mapTranslation,
      y: y,
      mapTranslationStart: mapTranslationStart,
      mapTranslationStartTime: mapTranslationStartTime,
      atWall: atWall
    });
    const pathEnd = this.getX({
      currentTime: endOfPath.time,
      mapTranslationStart: mapTranslationStart,
      mapTranslationStartTime: mapTranslationStartTime,
      mapTranslation: mapTranslation,
      atWall: atWall
    });
    const wall = this.findWall({
      mapTranslation: mapTranslation,
      mapTranslationStart: mapTranslationStart,
      mapTranslationStartTime: mapTranslationStartTime,
      maxX: pathEnd + SPRITE_SIDE,
      descendStartTime: descendStartTime,
      jumpStartTime: jumpStartTime,
      jumpState: jumpState,
      yStart: yStart,
      y: y,
      atWall: atWall
    });

    if (!wall || endOfPath.time < wall.time) {
      return endOfPath;
    } else {
      return wall;
    }
  }

  // determines what should happen when the sprite is moving up
  spriteGoingUp(props) {
    // declare local variables
    const {
      y,
      mapTranslation,
      yStart,
      descendStartTime,
      jumpState,
      jumpStartTime,
      atWall,
      mapTranslationStart,
      mapTranslationStartTime
    } = props;
    const jumpEndTime = JUMP_POWER / JUMP_SPEED + jumpStartTime;

    const jumpEndX = this.getX({
      currentTime: jumpEndTime,
      mapTranslationStart: mapTranslationStart,
      mapTranslationStartTime: mapTranslationStartTime,
      mapTranslation: mapTranslation,
      atWall: atWall
    });

    const wall = this.findWall({
      mapTranslation: mapTranslation,
      mapTranslationStart: mapTranslationStart,
      mapTranslationStartTime: mapTranslationStartTime,
      maxX: jumpEndX,
      descendStartTime: descendStartTime,
      jumpStartTime: jumpStartTime,
      jumpState: jumpState,
      yStart: yStart,
      y: y,
      atWall: atWall
    });
    if (!wall || wall.time > jumpEndTime) {
      return { time: jumpEndTime, event: 'fall' };
    } else {
      return wall;
    }
  }

  // determines what should happen when the sprite is moving down
  spriteGoingDown(props) {
    // declare local variables
    const {
      currentTime,
      minY,
      y,
      mapTranslation,
      yStart,
      descendStartTime,
      jumpState,
      jumpStartTime,
      atWall,
      mapTranslationStart,
      mapTranslationStartTime
    } = props;
    const maxX =
      this.getX({
        currentTime: this.getTimeForGivenY({
          yStart: yStart,
          y: minY,
          descendStartTime: descendStartTime,
          jumpState: jumpState,
          jumpStartTime: jumpStartTime,
          currentTime: currentTime
        }),
        mapTranslationStart: mapTranslationStart,
        mapTranslationStartTime: mapTranslationStartTime,
        mapTranslation: mapTranslation,
        atWall: atWall
      }) + SPRITE_SIDE;

    const wall = this.findWall({
      mapTranslation: mapTranslation,
      mapTranslationStart: mapTranslationStart,
      mapTranslationStartTime: mapTranslationStartTime,
      maxX: maxX,
      descendStartTime: descendStartTime,
      jumpStartTime: jumpStartTime,
      jumpState: jumpState,
      yStart: yStart,
      y: y,
      atWall: atWall
    });

    const path = this.findPath({
      currentTime: currentTime,
      mapTranslationStart: mapTranslationStart,
      mapTranslationStartTime: mapTranslationStartTime,
      mapTranslation: mapTranslation,
      atWall: atWall,
      yStart: yStart,
      descendStartTime: descendStartTime,
      jumpState: jumpState,
      jumpStartTime: jumpStartTime,
      maxX: maxX
    });

    if (wall && path) {
      if (path.time <= wall.time) {
        return path;
      } else {
        return wall;
      }
    } else if (wall) {
      return wall;
    } else if (path) {
      return path;
    } else {
      console.log('panic'); // this shouldn't happen
    }
  }

  findNextChange() {
    // declare local variables
    const currentTime = new Date().getTime();
    const y = this.getY();
    const mapTranslation = this.getMapTranslation();

    const {
      yStart,
      minY,
      descendStartTime,
      jumpState,
      jumpStartTime,
      atWall,
      mapTranslationStart,
      mapTranslationStartTime
    } = this.variables;

    // don't do anything if the character isn't moving
    if (jumpState !== jump.STOP || !atWall) {
      if (atWall) {
        /*
         * 3 options:
         *  1. the sprite jumps over the wall
         *  2. the sprite falls until it is below the wall then it moves past the wall
         *  3. the sprite falls until it hits the ground
         */
        return this.spriteAtWall({
          currentTime: currentTime,
          y: y,
          yStart: yStart,
          descendStartTime: descendStartTime,
          jumpState: jumpState,
          jumpStartTime: jumpStartTime,
          atWall: atWall,
          mapTranslation: mapTranslation,
          mapTranslationStart: mapTranslationStart,
          mapTranslationStartTime: mapTranslationStartTime
        });
      }
      // (!this.AtWall)
      else if (jumpState === jump.STOP) {
        /*
         * 2 options:
         *  1. the sprite hits a wall
         *  2. the sprite falls off the path
         */
        return this.spriteOnFlat({
          y: y,
          yStart: yStart,
          descendStartTime: descendStartTime,
          jumpState: jumpState,
          jumpStartTime: jumpStartTime,
          atWall: atWall,
          mapTranslation: mapTranslation,
          mapTranslationStart: mapTranslationStart,
          mapTranslationStartTime: mapTranslationStartTime
        });
      } else if (jumpState === jump.UP) {
        /*
         * 2 options:
         *  1. the sprite reaches max height and starts to fall down
         *  2. the sprite hits a wall while going up
         */
        return this.spriteGoingUp({
          y: y,
          yStart: yStart,
          descendStartTime: descendStartTime,
          jumpState: jumpState,
          jumpStartTime: jumpStartTime,
          atWall: atWall,
          mapTranslation: mapTranslation,
          mapTranslationStart: mapTranslationStart,
          mapTranslationStartTime: mapTranslationStartTime
        });
      }
      // (this.jumpState === jump.DOWN)
      else {
        /*
         * 2 options:
         *  1. the sprite lands on a path
         *  2. the sprite hits a wall while going down
         */
        return this.spriteGoingDown({
          currentTime: currentTime,
          minY: minY,
          y: y,
          yStart: yStart,
          descendStartTime: descendStartTime,
          jumpState: jumpState,
          jumpStartTime: jumpStartTime,
          atWall: atWall,
          mapTranslation: mapTranslation,
          mapTranslationStart: mapTranslationStart,
          mapTranslationStartTime: mapTranslationStartTime
        });
      }
    } else {
      return { time: undefined, event: 'nothing' };
    }
  }

  // sets gameStartTime and starts the necessary animation loops
  startLoops() {
    this.variables.gameStartTime = new Date().getTime();
    this.variables.mapTranslationStartTime = new Date().getTime();
    (async () => {
      this.variables.motionChange = this.findNextChange();
    })();

    this.updateInterval = setInterval(() => {
      const currentTime = new Date().getTime();
      const adjustedTime = this.variables.motionChange.time;
      if (
        this.variables.motionChange &&
        this.variables.motionChange.event !== 'nothing' &&
        adjustedTime - currentTime < TIME_THRESH &&
        !this.state.paused
      ) {
        //console.log(adjustedTime - currentTime);
        console.log(this.variables.motionChange.event);

        const y = this.getY({
          currentTime: adjustedTime,
          descendStartTime: this.variables.descendStartTime,
          jumpStartTime: this.variables.jumpStartTime,
          jumpState: this.variables.jumpState,
          yStart: this.variables.yStart,
          y: this.state.y
        });
        const mapTranslation = this.getMapTranslation({
          currentTime: adjustedTime,
          mapTranslationStart: this.variables.mapTranslationStart,
          mapTranslationStartTime: this.variables.mapTranslationStartTime,
          mapTranslation: this.state.mapTranslation,
          atWall: this.variables.atWall
        });
        if (this.variables.motionChange.event === 'block') {
          this.setState({
            mapTranslation: mapTranslation
          });
          this.variables.atWall = true;
        } else if (this.variables.motionChange.event === 'go') {
          this.variables.mapTranslationStart = mapTranslation;
          this.variables.mapTranslationStartTime = currentTime;
          this.variables.atWall = false;
        } else if (this.variables.motionChange.event === 'land') {
          this.setState({
            y: y - this.props.mapProps.strokeWidth / 2
          });
          this.variables.jumpState = jump.STOP;
        } else if (this.variables.motionChange.event === 'fall') {
          this.variables.descendStartTime = currentTime;
          this.variables.yStart = y;
          this.variables.jumpState = jump.DOWN;
        }
        this.variables.motionChange = undefined;
        (async () => {
          this.variables.motionChange = this.findNextChange();
        })();
      }
    }, UPDATE_TIMEOUT);

    this.renderInterval = setInterval(() => {
      if (this.variables.motionChange !== 'nothing' && !this.state.paused) {
        // 666 is a bad constant and should be declared elsewhere!
        if (this.getX() >= this.mapLength - 666) {
          this.endGame();
        } else {
          this.setState({
            mapTranslation: this.getMapTranslation(),
            y: this.getY()
          });
        }
      }
    }, RENDER_TIMEOUT);
  }

  componentWillUnmount() {
    // prevent memory leak by clearing/stopping loops
    clearInterval(this.renderInterval);
    clearInterval(this.updateInterval);
  }

  componentDidMount() {
    this.socket.on('connect', () => {
      /*
        Pass the player and a call back that will give back
        the a list of players.

        Each player contains the (x, y) coordinates of THAT player
        the list will include THIS player

        The call back is used in order to make sure that the players
        are set after the emit call
      */

      /*
        this will occur when another player has joined
        the game (not when THIS player has joined)
      */
      this.socket.on('PLAYER', data => {
        this.setState({ players: data });
      });

      /*
        Update the server with location of the
        players map ever UPDATE_INTERVAL milliseconds.

        Also emit a CHANGE_POS event that allows
        server to update all other players on position of this player
       */

      setInterval(() => {
        // should probably be a assign to a variable so it can be cleared see componentWillUnmount()
        const updatePlayer = {
          mapTrans: this.state.mapTranslation,
          y: this.state.y,
          color: this.state.color,
          key: this.socket.id
        };
        // use a callback
        this.socket.emit('CHANGE_POS', updatePlayer, data => {
          this.setState({ players: data });
        });
      }, UPDATE_INTERVAL);

      /*
        Using the mapTranslation allows THIS player to keep track of where OTHER
        players are in the game.
      */
      const player = {
        mapTrans: this.state.mapTranslation,
        y: this.state.y,
        color: this.state.color,
        key: this.socket.id
      };

      /*
        When a new player connects send the player
        to the server. The call back will have data about other players.

        To avoid having empty `rect' elements only set the state of
        the players when there is data sent from the server
      */
      this.socket.emit('NEW_PLAYER', player, data => {
        if (data !== undefined && data.length > 0) {
          this.setState({ players: data });
        }
      });
    });
  }

  render() {
    const docBody = document.querySelector('body');
    docBody.addEventListener('keypress', e => this.handleKeyPress(e));

    window.addEventListener(
      'resize',
      this.debounce(this.handleWindowResize, 500)
    );

    // now we need to account for other players that should be rendered
    const boxes = [
      <rect
        key={this.socket.id}
        rx={15}
        ry={15}
        x={this.variables.x}
        y={this.state.y}
        height={SPRITE_SIDE}
        width={SPRITE_SIDE}
        fill={this.state.color}
      />
    ];

    if (this.state.players !== undefined) {
      // TODO: need unique key for players
      boxes.push(
        this.state.players.map(player => {
          return (
            <rect
              key={player.id}
              rx={15}
              ry={15}
              // this difference allows for other players
              // to be rendered at different places in the map
              // based on their x coordinate
              x={this.state.mapTranslation - player.mapTrans}
              y={player.y}
              height={SPRITE_SIDE}
              width={SPRITE_SIDE}
              fill={player.color}
            />
          );
        })
      );
    }

    if (!this.state.tutorial) {
      return (
        <>
          <div>
            <Timer />
          </div>
          <SVGLayer
            viewBox={'0 0 2000 5000'}
            preserveAspectRatio={'xMaxYMin slice'}
            height={this.state.windowHeight}
            width={this.state.windowWidth}
          >
            <ProgressBar y={TOOLBAR_Y} />
            <Map
              translation={this.state.mapTranslation}
              map={this.props.mapProps.map}
              stroke={this.props.mapProps.strokeWidth}
            />
            {boxes}
            <g onClick={() => this.pauseGame()}>
              <rect
                key={'pause-bkrnd'}
                rx={15}
                ry={15}
                x={15}
                y={15}
                height={50}
                width={50}
                fill={'black'}
              />
              <rect
                key={'lft-line'}
                rx={5}
                ry={5}
                x={28}
                y={28}
                height={25}
                width={10}
                fill={'white'}
              />
              <rect
                key={'rt-line'}
                rx={5}
                ry={5}
                x={43}
                y={28}
                height={25}
                width={10}
                fill={'white'}
              />

              <g onClick={() => this.setState({ tutorial: true })}>
                {' '}
                {/* pauses game because within pausing div*/}
                <rect
                  key={'help-me'}
                  rx={15}
                  ry={15}
                  x={115}
                  y={15}
                  height={50}
                  width={50}
                  fill={'pink'}
                />
                <text x={135} y={45} height={50} width={50}>
                  ?
                </text>
              </g>
            </g>
          </SVGLayer>
          {this.state.paused ? (
            <SVGLayer
              viewBox={'0 0 2000 1000'}
              preserveAspectRatio={'xMinYMin meet'}
            >
              {this.state.changingKey ? (
                <ChangeKeyMenu
                  windowHeight={this.state.windowHeight}
                  windowWidth={this.state.windowWidth}
                  jumpKey={this.state.jumpKey}
                />
              ) : (
                <PauseMenu
                  windowHeight={this.state.windowHeight}
                  windowWidth={this.state.windowWidth}
                  resume={() => this.resumeGame()}
                  restart={() => this.restartGame()}
                  changeKey={() => this.setState({ changingKey: true })}
                  exitToMenu={() => this.exitToMenu()}
                />
              )}
            </SVGLayer>
          ) : (
            <></>
          )}
        </>
      );
    } else {
      return <Tutorial handlePlay={() => this.setState({ tutorial: false })} />;
    }
  }
}

export default GameEngine;
