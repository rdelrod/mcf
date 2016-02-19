/**
 * node-mc
 *
 * @author Jared Allard <jaredallard@outlook.com>
 * @license MIT
 * @version 0.0.1
 **/

 'use strict';

 const async   = require('async');
 const pty     = require('pty.js');
 const path    = require('path');
 const mkdirp  = require('mkdirp');
 const request = require('sync-request');
 const fs      = require('fs');
 const events  = require('events');
 const cspawn  = require('child_process').spawnSync;
 const spawn   = pty.spawn;

 // RegEx table
 const regex = {
   ctags: /\[([\w\d\s\\/.:]+)\]/gi,
   cinfo: /(\[[0-9:]+\]) (\[[\[A-Z\s\\/.\]]+: )/gi
 }

 // url consts
 const FORGE_INSTALLER="http://files.minecraftforge.net/maven/net/minecraftforge/forge/{{version}}/forge-{{version}}-installer.jar"
 const MINECRAFT_JAR="https://s3.amazonaws.com/Minecraft.Download/versions/{{version}}/minecraft_server.{{version}}.jar"

 /**
  * Get all matches of a regex capture group.
  *
  * @param {RegExp} regex - regex object
  * @param {String} string - string to exec on
  * @returns {Array} of matches
  **/
 function getRegexMatches(regex, string) {
   if(!(regex instanceof RegExp)) {
     return "ERROR";
   }

   const matches = [];
   let match = regex.exec(string);
   while (match) {
     if (match.length > 2) {
       const group_matches = [];
       for (var i = 1; i < match.length; i++) {
         group_matches.push(match[i]);
       }
       matches.push(group_matches);
     } else {
       matches.push(match[1]);
     }

     match = regex.exec(string);
   }

   return matches;
 }

 /**
  *  Download Forge and Install it.
  *
  * @param {String} version - version to install (forge)
  * @param {String} cwd - location to build forge.
  **/
 function downloadForgeAndInstall(version, cwd) {
   const filename = 'forge-'+version+'-installer.jar'
   const url = FORGE_INSTALLER.replace(/\{\{version\}\}/g, version);

   console.log('[node-mc] Fetching forge', version);
   console.log('[node-mc] URL:', url)

   let res = request('GET', url);

   try {
     fs.writeFileSync(path.join(cwd, filename), res.getBody(), {
       encoding: 'utf8'
     });
   } catch(err) {
     return false;
   }

   console.log('[node-mc] Installing Forge Server');

   let opts = [
     '-jar',
     filename,
     '--installServer'
   ];
   console.log('[node-mc] CLI: java', opts.toString().replace(/\,/g, ' '));

   let forge = cspawn('java', opts, {
     cwd: cwd,
     env: process.env
   });

   return true;
 }


 /**
  * @class mc
  **/
 class Mc {

   /**
    * Constructor for our mc class.
    *
    * @constructor
    **/
   constructor(cfg) {
     this.minecraft = {};
     this.pty = {}

     let minecraft_dir = cfg.minecraft.dir,
         minecraft_ver = cfg.minecraft.version,
         forge_version = cfg.minecraft.forge;

     if(minecraft_dir) {
       if(fs.existsSync(minecraft_dir) === false) {
         console.log('[mc-node] Running initial setup phase from config.')
         mkdirp.sync(minecraft_dir)

         if(!minecraft_ver) {
           downloadForgeAndInstall(forge_version, minecraft_dir);
         }
       }
     }

     // populate this object
     this.minecraft = cfg.minecraft;
     this.eventListeners = cfg.eventListeners;
     this.events = new events.EventEmitter;
   }

   /**
    * Send an event. Acts as a middleman for all events and types.
    **/
   sendEvent(type, to, args) {
     console.log('[node-mc] send event', 'type='+type, 'to='+to);
     console.log('[node-mc] args:', args);
   }

   /**
    * Build the initial events system
    **/
   populateEvents() {
     const self = this;

     console.log('[node-mc] Event Listener Init');
     for(let listener of this.eventListeners) {
       console.log('[node-mc] type='+listener.type, 'uri='+listener.uri);

       for(let levent of listener.events) {
         console.log('[node-mc] - event subscribed to', levent);
         this.events.on(levent, function(data) {
           self.sendEvent(listener.type, listener.uri, data);
         })
       }
     }

     console.log('[node-mc] Event Listener Finalized.');
   }

   /**
    * Global function to execute apt-get
    *
    * @param {String} dir - minecraft dir
    **/
   startServer(opts, dir) {
     let logfile;

     console.log('[node-mc] Utilzing Forge version', this.minecraft.forge);

     if(opts === undefined) {
       opts = [
         '-jar',
         'forge-'+this.minecraft.forge+'-universal.jar',
         'nogui'
       ]
     }

     if(dir === undefined) {
       dir = './minecraft'
     }

     logfile  = fs.createWriteStream(path.join(dir, 'node-mc.log'));

     let eula = path.join(dir, 'eula.txt')
     if(fs.existsSync(eula)) { // TODO: parse
       console.log('[node-mc] EULA set to true in', eula);
       fs.writeFileSync(eula, 'eula=true', {
         encoding: 'utf8'
       });
     }

     // spawn our pty.
     let term = spawn('java', opts, {
       name: 'xterm-color',
       cols: 5000,
       rows: 4000,
       uid: 0,
       cwd: dir,
       env: process.env
     });

     // set the pty state
     this.pty.running = true;
     this.pty.state = term;

     console.log('[node-mc] regex table:', regex)

     // TODO: implement array regex iterator.
     let self = this;
     term.on('data', function(data) {
       data = data.toString('ascii')

       // get the objects parsed
       let res   = getRegexMatches(regex.ctags, data);

       // hack to get info and not tags.
       let cinfo = data.replace(regex.cinfo, '')
        .replace(/\r/g, '')
        .replace(/\n/g, '')
        .replace('\u001b[m>', '');

       let pos = res.push(cinfo);

       if(res[0] != null && res[0] !== ' ' && res[0] !== '') {
         self.events.emit('console', res);
       }

       // check the status

       // log the output somewhere, somehow.
       logfile.write(data+'\n');
     });

     term.on('exit', function() {
       self.events.emit('status', 'stopped');
     });
   }

   /**
    * Determine if the pty is running
    **/
   isPtyRunning() {
     if(this.pty.running) {
       return true;
     }

     return false;
   }

   /**
    * Write data to the pty
    *
    * @param {String} data - to write
    **/
   writeToPty(data) {
     if(this.isPtyRunning()) {
       let term = this.pty.state;
       term.write(data+'\r')
       return true;
     }

     return false; // default fail
   }

   /**
    * Send a Command to the Minecraft server.
    *
    * @param {String} cmd - command
    **/
   sendCommand(cmd) {
     let res = this.writeToPty(cmd);

     if(!res) {
       return false;
     }

     return true;
   }
 }



const cfg = {
  eventListeners: [{
    type: 'webhook',
    uri: 'https://your-domain.com:port/url',
    events: [
      'status',
      'modAddition',
      'modDeletion',
      'versionChange'
    ]
  }],
  minecraft: {
    version: false, // use only if not utilizing forge.
    forge: "1.8.9-11.15.1.1752",
    dir: '/home/rylor/Code/node-mc/minecraft'
  }
}
const mc = new Mc(cfg);
mc.populateEvents();
mc.startServer();

setTimeout(function() {
  console.log('[node-mc] Stop the server');
  mc.sendCommand('stop');
}, 20000)
