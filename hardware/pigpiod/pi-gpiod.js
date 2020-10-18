module.exports = function(RED) {
    "use strict";
    var PigpioClient = require('pigpio-client');

    var PullMap = {
        "PUD_OFF":0,
        "PUD_DOWN":1,
        "PUD_UP":2
    };
    var bcm2pin = {
        "2":"3", "3":"5", "4":"7", "14":"8", "15":"10", "17":"11", "18":"12", "27":"13", "22":"15",
        "23":"16", "24":"18", "10":"19", "9":"21", "25":"22", "11":"23", "8":"24", "7":"26",
        "5":"29", "6":"31", "12":"32", "13":"33", "19":"35", "16":"36", "26":"37", "20":"38", "21":"40"
    };

    function returnErrorHandler(err_node) {
        var handler = function(err) {
            if(err_node.closing === false) {
                if (typeof err === 'string') {
                    err = new Error(err);
                }
                if(err === null || typeof err.message === 'undefined') {
                    err = new Error(RED._("node-red:common.status.error"))
                }
                if(err.message.startsWith("Unhandled socket error")) { // TODO Maybe improve this by leting pigpioclient return the socket error object instead
                    err_node.status({fill:"red", shape:"ring", text:err.message});
                }
                else {
                    err_node.status({fill:"red", shape:"ring", text:err.message+" "+err_node.host+":"+err_node.port});
                }
                if (!err_node.inerror) {
                    err_node.error(err);
                    err_node.inerror = true;
                }
                if( (typeof err_node.PiGPIO !== 'undefined') && (err_node.PiGPIO !== null) ) {
                    err_node.PiGPIO.end(); /* Do not use callback as it's only called on disconnected (this will not be done in all cases) */
                    err_node.PiGPIO = null;
                }
                err_node.retry = setTimeout(function() { err_node.doit(); }, 5000);
            }
        }
        return handler
    }

    function GPioInNode(n) {
        RED.nodes.createNode(this, n);
        this.host = n.host || "127.0.0.1";
        this.port = n.port || 8888;
        this.pin = n.pin;
        this.pio = bcm2pin[n.pin];
        this.intype = n.intype;
        this.read = n.read || false;
        this.debounce = Number(n.debounce || 25);
        if (this.debounce < 0) { this.debounce = 0; }
        if (this.debounce > 300000) { this.debounce = 300000; }
        this.closing = false;
        var node = this;
        node.inerror = false;

        if (node.pin !== undefined) {
            node.reconnectHandler = returnErrorHandler(node);
            node.status({fill:"grey", shape:"dot", text:"node-red:common.status.connecting"});
            node.doit = function() {
                if (node.retry) {
                    clearTimeout(node.retry);
                    node.retry = null;
                    if (RED.settings.verbose) { node.log("Retrying to connect"); }
                }
                node.PiGPIO = PigpioClient.pigpio({host: node.host, port: node.port});
                node.PiGPIO.addListener('error', node.reconnectHandler)
                node.PiGPIO.addListener('disconnected', node.reconnectHandler)
                node.PiGPIO.on('connected', (info) => {
                    node.inerror = false;
                    node.gpio = node.PiGPIO.gpio(Number(node.pin));
                    node.gpio.modeSet('input')
                    .then((result) => {
                        if (RED.settings.verbose) { node.log("modeSet result: "+result); }
                        return node.gpio.pullUpDown(PullMap[node.intype]);
                    }).then((result) => {
                        if (RED.settings.verbose) { node.log("pullUpDown result: "+result); }
                        return node.gpio.glitchSet(node.debounce);
                    }).then((result) => {
                        if (RED.settings.verbose) { node.log("glitchSet result: "+result); }
                        node.status({fill:"green",shape:"dot",text:"node-red:common.status.ok"});
                        node.gpio.notify((level, tick) => {
                            node.send({topic:"pi/"+node.pio, payload:Number(level)});
                            node.status({fill:"green",shape:"dot",text:level});
                        });
                        return;
                    }).then(() => {
                        if (node.read) {
                            setTimeout(() => {
                                node.gpio.read((err, level) => {
                                    if(err === null) {
                                        node.send({ topic:"pi/"+node.pio, payload:Number(level) });
                                        node.status({fill:"green",shape:"dot",text:level});
                                    }
                                    else {
                                        node.status({fill:"red", shape:"ring", text:"pi-gpiod.status.error_inital_read"});
                                    }
                                });
                            }, 20);
                        }
                        return;
                    }).catch((e) => {
                        if(e !== null) { node.error(e); } else { node.error("pi-gpiod.status.error_check_settings"); }
                        node.status({fill:"red", shape:"ring", text:"pi-gpiod.status.error_check_settings"});
                    });
                });
            };
            node.doit();
        }
        else {
            node.warn(RED._("pi-gpiod:errors.invalidpin")+": "+node.pio);
        }

        node.on("close", (done) => {
            node.closing = true;
            if (node.retry) {
                clearTimeout(node.retry); 
                node.retry = null;
            }
            // TODO check if node.gpio and node.PiGPIO are valid
            node.gpio.endNotify((error, response) => { // FIXME Doesn't work when we were not connected
                if (RED.settings.verbose) { node.log("endNotify() finished"); }
                node.PiGPIO.end();
                node.status({fill:"grey", shape:"ring", text:"pi-gpiod.status.closed"});
                done();
            });
        });
    }
    RED.nodes.registerType("pi-gpiod in", GPioInNode);

    function GPioOutNode(n) {
        RED.nodes.createNode(this,n);
        this.host = n.host || "127.0.0.1";
        this.port = n.port || 8888;
        this.pin = n.pin;
        this.pio = bcm2pin[n.pin];
        this.set = n.set || false;
        this.level = parseInt(n.level || 0);
        this.out = n.out || "out";
        this.freq = Number(n.freq || 800);
        if (this.freq < 5) { this.freq = 5; }
        if (this.freq > 40000) { this.freq = 40000; }
        this.sermin = Number(n.sermin)/100;
        this.sermax = Number(n.sermax)/100;
        if (this.sermin > this.sermax) {
            var tmp = this.sermin;
            this.sermin = this.sermax;
            this.sermax = tmp;
        }
        if (this.sermin < 5) { this.sermin = 5; }
        if (this.sermax > 25) { this.sermax = 25; }
        this.closing = false;
        var node = this;
        node.initFinished = false;
        node.inerror = false;

        function inputlistener(msg) {
            if (msg.payload === "true") { msg.payload = 1; }
            if (msg.payload === "false") { msg.payload = 0; }
            if (node.out === "ser" && (msg.payload === null || msg.payload === "")) { msg.payload = 0; }
            msg.payload = Number(msg.payload);
            var limit = 1;
            if (node.out !== "out") { limit = 100; }
            if ((msg.payload >= 0) && (msg.payload <= limit)) {
                if (RED.settings.verbose) { node.log("out: "+msg.payload); }
                if (node.initFinished && !node.inerror) {
                    new Promise((resolve, reject) => {
                        if (node.out === "out") {
                            node.gpio.write(msg.payload, (error, response) => {
                                if (error === null) { resolve(response); }
                                else { reject(error); }
                            });
                        }
                        if (node.out === "pwm") {
                            node.gpio.setPWMdutyCycle(Math.trunc(msg.payload * 2.55), (error, response) => {
                                if (error === null) { resolve(response); }
                                else { reject(error); }
                            });
                        }
                        if (node.out === "ser") {
                            // TODO check if ser works with null, "" inputs -> don't think so as first part of calculation should be > 0 -> maybe add extra flag
                            var r = (node.sermax - node.sermin) * 100;
                            node.gpio.setServoPulsewidth(Math.trunc(1500 - (r/2) + (msg.payload * r / 100)), (error, response) => {
                                if (error === null) { resolve(response); }
                                else { reject(error); }
                            });
                        }
                    }).then((result) => {
                        if (RED.settings.verbose) { node.log("out result: "+result); }
                        node.status({fill:"green",shape:"dot",text:msg.payload.toString()});
                        return;
                    }).catch((e) => {
                        /* We need etxra error handling here because 'error' callback leads to a reconnect */
                        if(e !== null) {
                            node.warn(e);
                        }
                        else {
                            node.warn(RED._("pi-gpiod:errors.invalidinput")+": "+msg.payload);
                        }
                    });
                }
                else {
                    node.status({fill:"grey",shape:"ring",text:"N/C: " + msg.payload.toString()});
                }
            }
            else {
                node.warn(RED._("pi-gpiod:errors.invalidinput")+": "+msg.payload);
            }
        }

        if (node.pin !== undefined) {
            node.reconnectHandler = returnErrorHandler(node);
            node.status({fill:"grey", shape:"dot", text:"node-red:common.status.connecting"});
            node.doit = function() {
                if (node.retry) {
                    clearTimeout(node.retry);
                    node.retry = null;
                    if (RED.settings.verbose) { node.log("Retrying to connect"); }
                }
                node.PiGPIO = PigpioClient.pigpio({host: node.host, port: node.port});
                node.PiGPIO.addListener('error', node.reconnectHandler)
                node.PiGPIO.addListener('disconnected', node.reconnectHandler)
                node.PiGPIO.on('connected', (info) => {
                    node.inerror = false;
                    node.gpio = node.PiGPIO.gpio(Number(node.pin));
                    node.gpio.modeSet('output')
                    .then((result) => {
                        if (RED.settings.verbose) { node.log("modeSet result: "+result); }
                        if(node.out === "pwm") {
                            return node.gpio.setPWMfrequency(node.freq);
                        }
                        else if (node.set) {
                            return node.gpio.write(node.level);
                        }
                        else {
                            return null; /* OK */
                        }
                    }).then((result) => {
                        if(node.set) {
                            if (RED.settings.verbose) { node.log("write result: "+result); }
                            node.status({fill:"green",shape:"dot",text:node.level});
                        }
                        else {
                            if (RED.settings.verbose && node.out === "pwm") { node.log("setPWMfrequency result: "+result); }
                            node.status({fill:"green",shape:"dot",text:"node-red:common.status.ok"});
                        }
                        node.initFinished = true;
                        return;
                    }).catch((e) => {
                        if(e !== null) { node.error(e); } else { node.error("pi-gpiod.status.error_check_settings"); }
                        node.status({fill:"red", shape:"ring", text:"pi-gpiod.status.error_check_settings"});
                    });
                });
            };
            node.doit();
            node.on("input", inputlistener);
        }
        else {
            node.warn(RED._("pi-gpiod:errors.invalidpin")+": "+node.pio);
        }

        node.on("close", (done) => {
            node.closing = true;
            if (node.retry) {
                clearTimeout(node.retry); 
                node.retry = null;
            }
            node.PiGPIO.end();// TODO check if node.PiGPIO is valid
            node.status({fill:"grey",shape:"ring",text:"pi-gpiod.status.closed"});
            done();
        });
    }
    RED.nodes.registerType("pi-gpiod out", GPioOutNode);
}
