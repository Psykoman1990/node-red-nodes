module.exports = function(RED) {
    "use strict";
    var PigpioClient = require('pigpio-client');
    var util = require('util');

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
    var pinTypes = {
        "PUD_OFF":RED._("pi-gpiod:types.input"),
        "PUD_UP":RED._("pi-gpiod:types.pullup"),
        "PUD_DOWN":RED._("pi-gpiod:types.pulldown"),
        "out":RED._("pi-gpiod:types.digout"),
        "pwm":RED._("pi-gpiod:types.pwmout"),
        "ser":RED._("pi-gpiod:types.servo")
    };

    function GPioInNode(n) {
        RED.nodes.createNode(this, n);
        this.host = n.host || "127.0.0.1";
        this.port = n.port || 8888;
        this.pin = n.pin;
        this.pio = bcm2pin[n.pin];
        this.intype = n.intype;
        this.read = n.read || false;
        this.debounce = Number(n.debounce || 25);
        this.closing = false;
        var node = this;
        var PiGPIO;

        if (node.pin !== undefined) {
            var inerror = false;
            node.status({fill:"grey", shape:"dot", text:"node-red:common.status.connecting"});

            var errorHandler = function(err) {
                if(node.closing === false) {
                    if (typeof e === 'string') {
                        e = new Error(e);
                    }
                    
                    if(typeof err.message !== 'undefined') {
                        node.status({fill:"red", shape:"ring", text:err.message+" "+node.host+":"+node.port});
                    }
                    else {
                        node.status({fill:"red", shape:"ring", text:"General eror "+node.host+":"+node.port});
                    }
                    
                    if (!inerror) {
                        node.error(err);
                        inerror = true;
                    }

                    if( (typeof PiGPIO !== 'undefined') && (PiGPIO !== null) ) {
                        PiGPIO.end(); // Do not use callback as it's only called on disconnected (this is not in all cases)
                        PiGPIO = null;
                    }

                    node.retry = setTimeout(function() { doit(); }, 5000);
                }
            }

            var doit = function() {
                if (node.retry) {
                    clearTimeout(node.retry);
                    node.retry = null;
                }

                PiGPIO = PigpioClient.pigpio({host: node.host, port: node.port});

                PiGPIO.on('error', errorHandler);
                PiGPIO.on('disconnected', errorHandler);

                PiGPIO.on('connected', (info) => {
                    inerror = false;

                    node.gpio = PiGPIO.gpio(Number(node.pin));

                    node.gpio.modeSetAsync = util.promisify(node.gpio.modeSet);
                    node.gpio.pullUpDownAsync = util.promisify(node.gpio.pullUpDown);
                    node.gpio.glitchSetAsync = util.promisify(node.gpio.glitchSet);

                    node.gpio.modeSetAsync('input')
                    .then(node.gpio.pullUpDownAsync(PullMap[node.intype]))
                    .then(node.gpio.glitchSetAsync(node.debounce))
                    .then(function(result) {
                        node.status({fill:"green",shape:"dot",text:"node-red:common.status.ok"});
                        node.gpio.notify(function(level, tick) {
                            node.send({topic:"pi/"+node.pio, payload:Number(level)});
                            node.status({fill:"green",shape:"dot",text:level});
                        });
                        if (node.read) {
                            setTimeout(function() {
                                node.gpio.read(function(err, level) {
                                    node.send({ topic:"pi/"+node.pio, payload:Number(level) });
                                    node.status({fill:"green",shape:"dot",text:level});
                                });
                            }, 20);
                        }
                    })
                    .catch(function(e) { errorHandler(error);})
                });
            };
            doit();
        }
        else {
            node.warn(RED._("pi-gpiod:errors.invalidpin")+": "+node.pio);
        }

        node.on("close", function(done) {
            node.closing = true;
            if (node.retry) {
                clearTimeout(node.retry);
                node.retry = null;
            }
            node.status({fill:"grey", shape:"ring", text:"pi-gpiod.status.closed"});
            node.gpio.endNotify(function(error, response) {
                PiGPIO.end(function() {
                    done();
                });
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
        var PiGPIO;

        function inputlistener(msg) {
            node.log("Triggered via input");
            if (msg.payload === "true") { msg.payload = true; }
            if (msg.payload === "false") { msg.payload = false; }
            var out = Number(msg.payload);
            var limit = 1;
            if (node.out !== "out") { limit = 100; }
            if ((out >= 0) && (out <= limit)) {
                if (RED.settings.verbose) { node.log("out: "+msg.payload); }
                if (!inerror) {
                    if (node.out === "out") {
                        node.gpio.write(msg.payload);
                    }
                    if (node.out === "pwm") {
                        node.gpio.setPWMdutyCycle(parseInt(msg.payload * 2.55));
                    }
                    if (node.out === "ser") {
                        var r = (node.sermax - node.sermin) * 100;
                        //node.gpio.setServoPulsewidth(parseInt(1500 - (r/2) + (msg.payload * r / 100)));
                    }
                    node.status({fill:"green",shape:"dot",text:msg.payload.toString()});
                }
                else {
                    node.status({fill:"grey",shape:"ring",text:"N/C: " + msg.payload.toString()});
                }
            }
            else { node.warn(RED._("pi-gpiod:errors.invalidinput")+": "+out); }
        }

        if (node.pin !== undefined) {
            var inerror = false;
            node.status({fill:"grey", shape:"dot", text:"node-red:common.status.connecting"});

            var errorHandler = function(err) {
                if(node.closing === false) {
                    if (typeof e === 'string') {
                        e = new Error(e);
                    }
                    
                    if(typeof err.message !== 'undefined') {
                        node.status({fill:"red", shape:"ring", text:err.message+" "+node.host+":"+node.port});
                    }
                    else {
                        node.status({fill:"red", shape:"ring", text:"General eror "+node.host+":"+node.port});
                    }
                    
                    if (!inerror) {
                        node.error(err);
                        inerror = true;
                    }

                    if( (typeof PiGPIO !== 'undefined') && (PiGPIO !== null) ) {
                        PiGPIO.end(); // Do not use callback as it's only called on disconnected (this is not in all cases)
                        PiGPIO = null;
                    }

                    node.retry = setTimeout(function() { doit(); }, 5000);
                }
            }

            var doit = function() {
                if (node.retry) {
                    clearTimeout(node.retry);
                    node.retry = null;
                }

                PiGPIO = PigpioClient.pigpio({host: node.host, port: node.port});

                PiGPIO.on('error', errorHandler);
                PiGPIO.on('disconnected', errorHandler);

                PiGPIO.on('connected', (info) => {
                    inerror = false;

                    node.gpio = PiGPIO.gpio(Number(node.pin));

                    node.gpio.modeSetAsync = util.promisify(node.gpio.modeSet);
                    node.gpio.writeAsync = util.promisify(node.gpio.write);

                    if(node.set) {
                        node.gpio.modeSetAsync('output')
                        .then(node.gpio.writeAsync(node.level))
                        .then(function(result) {
                            node.status({fill:"green",shape:"dot",text:node.level});
                        })
                        .catch(function(e) { errorHandler(error);})
                    }
                    else {
                        node.gpio.modeSetAsync('output')
                        .then(function(result) {
                            node.status({fill:"green",shape:"dot",text:"node-red:common.status.ok"});
                        })
                        .catch(function(e) { errorHandler(error);})
                    }
                });
            };
            doit();
            node.on("input", inputlistener);
        }
        else {
            node.warn(RED._("pi-gpiod:errors.invalidpin")+": "+node.pio);
        }

        node.on("close", function(done) {
            node.closing = true;
            if (node.retry) {
                clearTimeout(node.retry);
                node.retry = null;
            }
            node.status({fill:"grey",shape:"ring",text:"pi-gpiod.status.closed"});
            PiGPIO.close();
            done();
        });
    }
    RED.nodes.registerType("pi-gpiod out", GPioOutNode);
}
