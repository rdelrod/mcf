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
 const asyncrq = require('request');
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
   cinfo: /(\[[0-9:]+\]) (\[[\[A-Z\s\\/.\]]+: )/gi,
   cdone: /Done \(([0-9\.]+)s\)\!/gi
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

   console.log('[node-mcf] Fetching forge', version);
   console.log('[node-mcf] URL:', url)

   let res = request('GET', url);

   try {
     fs.writeFileSync(path.join(cwd, filename), res.getBody(), {
       encoding: 'utf8'
     });
   } catch(err) {
     return false;
   }

   console.log('[node-mcf] Installing Forge Server');

   let opts = [
     '-jar',
     filename,
     '--installServer'
   ];
   console.log('[node-mcf] CLI: java', opts.toString().replace(/\,/g, ' '));

   let forge = cspawn('java', opts, {
     cwd: cwd,
     env: process.env
   });

   fs.unlinkSync(path.join(cwd, filename));

   return true;
 }


 /**
  * @class mc
  **/
 module.exports = class Mc {

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
         console.log('[mcf-node] Running initial setup phase from config.')
         mkdirp.sync(minecraft_dir)

         // install forge or basic mc
         if(!minecraft_ver) {
           downloadForgeAndInstall(forge_version, minecraft_dir);
         }
       }

       if(fs.existsSync(minecraft_mods)) {
         let mods = JSON.parse(fs.readFileSync(minecraft_mods, 'utf8'));
         this.mods = mods;
       } else {
         console.log('[node-mcf] mods.json will be intialized.')
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

     console.log('[node-mcf] Building initial mod database')
     console.log('[node-mcf] mod_dir='+mod_dir)
     fs.readdir(mod_dir, function(err, files) {
       if(err) {
         console.log('Failed To Build Database');
         console.log(err.stack);
         process.exit(1);
       }

       async.each(files, function(mod, next) {
         let cmod = path.join(mod_dir, mod);

         // verify if dir or not
         if(fs.lstatSync(cmod).isDirectory()) {
           return next();
         }

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
     const mod_dir     = path.join(this.minecraft.dir, 'mods');
     const self        = this;
     const clientModsP = path.join(this.minecraft.dir, 'clientmods.json');
     const clientMods  = [];
     const modEventQ   = [];

     if(fs.existsSync(clientMods)) {
       clientMods = require(clientModsP);
     }

     if(this.mods === undefined) {
       console.error('Something happened during the database build.')
       console.log('Please remove mods.json and try again.')
       process.exit(1);
     }

     console.log('[node-mcf] checking for mod changes...')

     let i = 0;
     for(let mod of self.mods) {
       let mloc = path.join(mod_dir, mod.filename);

       if(!fs.existsSync(mloc)) {
         modEventQ.push({
           data: mod,
           event: 'modDeletion'
         });
         self.mods.splice(i, 1);
       }

       i++;
     }

     fs.readdir(mod_dir, function(err, files) {
       if(err) {
         console.log('Failed To Build Database');
         console.log(err.stack);
         process.exit(1);
       }

       async.each(files, function(mod, next) {
         let cmod = path.join(mod_dir, mod);

         // check is dir.
         if(fs.lstatSync(cmod).isDirectory()) {
           return next();
         }

         let fd   = fs.createReadStream(cmod),
             hash = crypto.createHash('sha512');

         // set the hash streams encoding.
         hash.setEncoding('hex');

         fd.on('end', function() {
           // signify the end of the hash buffer.
           hash.end();

           // check if the mod is installed all ready
           let mod_installed = self.mods.filter(function ( obj ) {
               return obj.filename === mod;
           })[0];

           if(!mod_installed) {
             console.log('[node-mcf] new mod:', mod);

             // new value
             mod_installed = {
               filename: mod,
               hash: hash.read()
             }

             // push to mod dir, and event q
             self.mods.push(mod_installed);
             modEventQ.push({
               data: mod_installed,
               event: 'modAddition'
             });
           } else {
             const modHash = hash.read();

             // if the hash is different, trigger modUpdated.
             if(modHash !== mod_installed.hash) {
               self.mods[mod_installed.index].hash = modHash;
               modEventQ.push({
                 data: self.mods[mod_installed.index],
                 event: 'modUpdated'
               });
             }
           }

           return next();
         });

         // read all file and pipe it (write it) to the hash object
         fd.pipe(hash);
       }, function(err) {

         /**
          * Send the events w/o repetition.
          **/
         let sendEvents = function(a, event) {
           const data = [];
           for(let mod of a) {
             if(mod.event === event) {
               data.push(mod.data);
             }
           }

           // check if anything actually came up.
           if(data[0] === undefined || data[0] === null) {
             return false;
           }

           self.events.emit(event, {
             mods: data
           })
         }

         sendEvents(modEventQ, 'modAddition');
         sendEvents(modEventQ, 'modDeletion');
         sendEvents(modEventQ, 'modUpdated');

         // update the disk file.
         let data = JSON.stringify(self.mods);
         fs.writeFile(path.join(self.minecraft.dir, 'mods.json'), data, function(err) {
           if(err) {
             console.error('Failed to save mods');
             console.log(err.stack);
             process.exit(1);
           }
         });

         fs.writeFile(clientModsP, JSON.stringify(clientMods), function(err) {
         })
       });
     });

     return true;
   }

   /**
    * Send an event. Acts as a middleman for all events and types.
    *
    * @param {String} type - type of send, i.e webhook
    * @param {String} to - uri to send too
    * @param {...} args - arguments to send.
    **/
   sendEvent(type, to, args) {
     console.log('[node-mcf] send event', 'type='+type, 'to='+to);
     console.log('[node-mcf] args:', args);

     if(type === 'webhook') {
       let data = args;

       // send the event
       let res = asyncrq({
         method: 'post',
         body: data,
         json: true,
         url: to
       })

       // on error
       res.on('error', function(err) {
         console.warn('[node-mcf] Failed to send event.');
         console.log(err.stack);
       })
     } else {
       console.warn('[node-mcf] Failed to send event. Unknown type', '"'+type+'"')
     }
   }

   /**
    * Build the initial events system
    **/
   populateEvents() {
     const self = this;

     console.log('[node-mcf] Event Listener Init');
     for(let listener of this.eventListeners) {
       console.log('[node-mcf] type='+listener.type, 'uri='+listener.uri);

       for(let levent of listener.events) {
         console.log('[node-mcf] - event subscribed to', levent);
         this.events.on(levent, function(data) {
           self.sendEvent(listener.type, listener.uri, {
             event: levent,
             data: data
           });
         })
       }
     }

     console.log('[node-mcf] Event Listener Finalized.');
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

     console.log('[node-mcf] Utilzing Forge version', this.minecraft.forge);

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

     logfile  = fs.createWriteStream(path.join(dir, 'node-mcf.log'));

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

     const versionFile = path.join(dir, 'version.json');
     if(!fs.existsSync(versionFile)) {
       let data = {
         version: self.minecraft.version,
         forge: self.minecraft.forge
       }

       fs.writeFileSync(versionFile, JSON.stringify(data), 'utf8');
     }

     /**
      * Check if we have been instructed to update forge.
      **/
     const versionFileC = JSON.parse(fs.readFileSync(versionFile));
     if(versionFileC.version === false) {
       if(versionFileC.forge !== self.minecraft.forge) {
         let oldMc = path.join(dir, 'forge-'+versionFileC.forge+'-universal.jar');

         // delete old version
         if(fs.existsSync(oldMc)) {
           fs.unlinkSync(oldMc);
         }

         console.log('[node-mcf] instructed to update forge...')
         downloadForgeAndInstall(self.minecraft.forge, dir);

         // write the new version
         versionFileC.forge = self.minecraft.forge;
         fs.writeFileSync(versionFile, JSON.stringify(versionFileC), 'utf8');

         self.events.emit('versionChange', {
           newVersion: self.minecraft.forge,
           oldVersion: versionFileC.forge
         })
       }
     }

     let eula = path.join(dir, 'eula.txt')
     if(fs.existsSync(eula)) { // TODO: parse
       console.log('[node-mcf] EULA set to true in', eula);
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

     // emit the started event
     self.events.emit('status', 'starting');

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

       // server is up
       let isDone = regex.cdone.exec(cinfo);
       if(isDone !== null) {
         self.events.emit('status', 'up');
       }

       // check the status

       // log the output somewhere, somehow.
       logfile.write(data+'\n');
     });

     term.on('exit', function() {
       fs.unlinkSync(path.join(self.minecraft.dir, 'node-mcf.log'));
       self.events.emit('status', 'down');
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

   /**
    * Op a player.
    **/
   op(player) {
     if(!this.isPtyRunning()) {
       return false;
     }

     return this.sendCommand('op '+player);
   }

   /**
    * De-op a player
    **/
   deop(player) {
     if(!this.isPtyRunning()) {
       return false;
     }

     return this.sendCommand('deop '+player);
   }

   /**
    * Remove a world.
    **/
   removeWorld(name) {
     const self = this;
     let worldDir = path.join(this.minecraft.dir, name);

     if(!name) {
       return {
         success: false,
         reason: 'INVOKE'
       }
     }

     if(this.isPtyRunning()) {
       return {
         success: false,
         reason: 'PTY'
       };
     }

     if(fs.existsSync(worldDir)) {
       console.log('[node-mcf] remove world:', name);

       var deleteFolderRecursive = function(path) {
        if( fs.existsSync(path) ) {
          fs.readdirSync(path).forEach(function(file,index){
            var curPath = path + "/" + file;
            if(fs.lstatSync(curPath).isDirectory()) { // recurse
              deleteFolderRecursive(curPath);
            } else { // delete file
              fs.unlinkSync(curPath);
            }
          });
          fs.rmdirSync(path);
        }
      };

      deleteFolderRecursive(worldDir);

      console.log('[node-mcf] world destroyed.');

      return {
        success: true
      }
    } else {
      return {
        success: false,
        reason: 'NOTEXIST'
      }
    }
   }
 }
