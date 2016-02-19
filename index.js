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
 const crypto  = require('crypto');
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

     let minecraft_dir  = cfg.minecraft.dir,
         minecraft_ver  = cfg.minecraft.version,
         forge_version  = cfg.minecraft.forge,
         minecraft_mods = path.join(cfg.minecraft.dir, 'mods.json');

     if(minecraft_dir) {
       if(fs.existsSync(minecraft_dir) === false) {
         console.log('[mc-node] Running initial setup phase from config.')
         mkdirp.sync(minecraft_dir)

         // install forge or basic mc
         if(!minecraft_ver) {
           downloadForgeAndInstall(forge_version, minecraft_dir);
         }
       }

       if(fs.existsSync(minecraft_mods)) {
         let mods = require(minecraft_mods);
         this.mods = mods;
       } else {
         console.log('[node-mc] mods.json will be intialized.')
         this.mods = [];
       }
     }

     // populate this object
     this.minecraft = cfg.minecraft;
     this.eventListeners = cfg.eventListeners;
     this.events = new events.EventEmitter;
   }

   /**
    * Build the initial database of mods.
    **/
   buildModDatabase() {
     const mod_dir = path.join(this.minecraft.dir, 'mods');
     const self = this;

     // just in case.
     if(!fs.existsSync(mod_dir)) {
       mkdirp.sync(mod_dir);
     }

     console.log('[node-mc] Building initial mod database')
     console.log('[node-mc] mod_dir='+mod_dir)
     fs.readdir(mod_dir, function(err, files) {
       if(err) {
         console.log('Failed To Build Database');
         console.log(err.stack);
         process.exit(1);
       }

       async.each(files, function(mod, next) {
         let cmod = path.join(mod_dir, mod);
         let fd = fs.createReadStream(cmod);
         let hash = crypto.createHash('sha512');
         hash.setEncoding('hex');

         fd.on('end', function() {
           // signify the end of the hash buffer.
           hash.end();

           // push the mod to the mod array
           self.mods.push({
             filename: mod,
             hash: hash.read()
           });

           return next();
         });

         // read all file and pipe it (write it) to the hash object
         fd.pipe(hash);
       }, function(err) {
         // write file to disk
         console.log(self.mods);
         fs.writeFile(path.join(self.minecraft.dir, 'mods.json'), JSON.stringify(self.mods), function(err) {
           if(err) {
             console.error('Failed to save mods');
             console.log(err.stack);
             process.exit(1);
           }
         });
       });
     });
   }

   /**
    * Check the minecraft version / forge version
    **/
   checkMinecraftVersion() {

   }

   /**
    * Scan for new mods
    **/
   scanForNewMods() {
     const mod_dir = path.join(this.minecraft.dir, 'mods');
     const self    = this;

     if(this.mods === undefined) {
       console.error('Something happened during the database build.')
       console.log('Please remove mods.json and try again.')
       process.exit(1);
     }

     /**
      * Check if a mod is registered in our database
      **/
     let modIsInstalled = function(name, type) {
       if(type === undefined) {
         type = 'name'
       }

       let i = 0;
       for(let mod in self.mods) {
         const rmod = self.mods[mod];

         // instancing.
         let cmod = {
           filename: rmod.filename,
           hash: rmod.hash,
           index: i
         }

         if(rmod.filename === name) {
           return cmod;
         }

         i++;
       }

       console.log('[node-mc] [modIsInstalled] false')
       return false;
     }

     fs.readdir(mod_dir, function(err, files) {
       if(err) {
         console.log('Failed To Build Database');
         console.log(err.stack);
         process.exit(1);
       }

       async.each(files, function(mod, next) {
         let cmod = path.join(mod_dir, mod);
         let fd   = fs.createReadStream(cmod),
             hash = crypto.createHash('sha512');

         // set the hash streams encoding.
         hash.setEncoding('hex');

         fd.on('end', function() {
           // signify the end of the hash buffer.
           hash.end();

           // push the mod to the mod array
           const mod_installed = modIsInstalled(mod);
           if(!mod_installed) {
             console.log('[node-mc] new mod installed');

             // push the new mod object to the mod array, that is saved to disk.
             self.mods.push({
               filename: mod,
               hash: hash.read()
             });

             self.events.emit('modAddition', self.mods[self.mods.legnth-1]);
           } else {
             const modHash = hash.read();

             // if the hash is different, trigger modUpdated.
             if(modHash !== mod_installed.hash) {
               self.mods[mod_installed.index].hash = modHash;
               self.events.emit('modUpdated', self.mods[mod_installed.index]);
             }
           }

           return next();
         });

         // read all file and pipe it (write it) to the hash object
         fd.pipe(hash);
       }, function(err) {
         fs.writeFile(path.join(self.minecraft.dir, 'mods.json'), JSON.stringify(self.mods), function(err) {
           if(err) {
             console.error('Failed to save mods');
             console.log(err.stack);
             process.exit(1);
           }
         });
       });
     });

     return true;
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
    * @param {Array} opts - opts to give to java, must include the jar file.
    * @param {String} dir - minecraft dir
    **/
   startServer(opts, dir) {
     const self = this;
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

     // start the event listener
     this.populateEvents();

     if(!this.minecraft.version) {
       // start the mod reader.
       if(!fs.existsSync(path.join(dir, 'mods.json'))) {
         this.buildModDatabase();
       } else {
         this.scanForNewMods();
       }
     }

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

     // TODO: implement array regex iterator.
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
      'modUpdated',
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
mc.startServer();

setTimeout(function() {
  console.log('[node-mc] Stop the server');
  mc.sendCommand('stop');
}, 20000)
