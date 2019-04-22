
module.exports = function(RED) {
    "use strict";

    var Board = require('firmata');
    var SP = require('serialport');

    // The Board Definition - this opens (and closes) the connection
    function ArduinoNode(n) {
        RED.nodes.createNode(this,n);
        this.device = n.device || null;
        var node = this;
        var running = false;
        var reported = false;

        var startup = function() {
            node.board = new Board(node.device, function(e) {
                if ((e !== undefined) && (e.toString().indexOf("cannot open") !== -1) ) {
                    if (!reported) {
                        node.error(RED._("arduino.errors.portnotfound",{device:node.device}));
                        reported = true;
                    }
                }
                else if (e === undefined) {
                    running = true;
                    reported = false;
                    node.board.once('ready', function() {
                        node.log(RED._("arduino.status.connected",{device:node.board.sp.path}));
                        if (RED.settings.verbose) {
                            node.log(RED._("arduino.status.version",{version:node.board.firmware.name+"-"+node.board.version.major+"."+node.board.version.minor}));
                        }
                    });
                    node.board.once('close', function() {
                        node.error(RED._("arduino.status.portclosed"));
                    });
                    node.board.once('disconnect', function() {
                        if (running) { setTimeout(function() { running = false; startup(); }, 5000); }
                    });
                }
            });
            setTimeout(function() { if (!running) { startup(); } }, 5000);
        };
        startup();

        node.on('close', function(done) {
            running = false;
            if (node.board) {
                try {
                    node.board.transport.close(function() {
                        if (RED.settings.verbose) { node.log(RED._("arduino.status.portclosed")); }
                        done();
                    });
                }
                catch(e) { done(); }
            }
            else { done(); }
        });
    }
    RED.nodes.registerType("arduino-board",ArduinoNode);


    // The Input Node
    function DuinoNodeIn(n) {
        RED.nodes.createNode(this,n);
        this.buttonState = -1;
        this.pin = n.pin;
        this.state = n.state;
        this.arduino = n.arduino;
        this.serverConfig = RED.nodes.getNode(this.arduino);
        this.running = false;
        var node = this;
        if (typeof this.serverConfig === "object") {
            var startup = function() {
                node.board = node.serverConfig.board;
                node.oldval = "";
                node.status({fill:"grey",shape:"ring",text:"node-red:common.status.connecting"});
                var doit = function() {
                    node.running = true;
                    node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
                    if (node.state === "ANALOG") {
                        node.board.pinMode(node.pin, 0x02);
                        node.board.analogRead(node.pin, function(v) {
                            if (v !== node.oldval) {
                                node.oldval = v;
                                node.send({payload:v, topic:"A"+node.pin});
                            }
                        });
                    }
                    if (node.state === "INPUT") {
                        node.board.pinMode(node.pin, 0x00);
                        node.board.digitalRead(node.pin, function(v) {
                            if (v !== node.oldval) {
                                node.oldval = v;
                                node.send({payload:v, topic:node.pin});
                            }
                        });
                    }
                    if (node.state === "PULLUP") {
                        node.board.pinMode(node.pin, 0x0B);
                        node.board.digitalRead(node.pin, function(v) {
                            if (v !== node.oldval) {
                                node.oldval = v;
                                node.send({payload:v, topic:node.pin});
                            }
                        });
                    }
                    if (node.state == "STRING") {
                        node.board.on('string', function(v) {
                            if (v !== node.oldval) {
                                node.oldval = v;
                                node.send({payload:v, topic:"string"});
                            }
                        });
                    }
                    node.board.once('disconnect', function() {
                        node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
                        if (node.running) { setTimeout(function() { node.running = false; startup(); }, 5500); }
                    });
                }
                if (node.board.isReady) { doit(); }
                else { node.board.once("ready", function() { doit(); }); }
                setTimeout(function() { if (node.running === false) { startup(); } }, 4500);
            }
            startup();
        }
        else {
            node.warn(RED._("arduino.errors.portnotconf"));
        }
        node.on('close', function() {
            node.running = false;
        });
    }
    RED.nodes.registerType("arduino in",DuinoNodeIn);


    // The Output Node
    function DuinoNodeOut(n) {
        RED.nodes.createNode(this,n);
        this.buttonState = -1;
        this.pin = n.pin;
        this.state = n.state;
        this.arduino = n.arduino;
        this.serverConfig = RED.nodes.getNode(this.arduino);
        this.running = false;
        var node = this;
        if (typeof node.serverConfig === "object") {
            var startup = function() {
                node.board = node.serverConfig.board;
                node.status({fill:"grey",shape:"ring",text:"node-red:common.status.connecting"});
                var doit = function() {
                    node.running = true;
                    node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
                    node.on("input", function(msg) {
                        if (node.board.isReady) {
                            if (node.state === "OUTPUT") {
                                node.board.pinMode(node.pin, 0x01);
                                if ((msg.payload === true)||(msg.payload.toString() == "1")||(msg.payload.toString().toLowerCase() == "on")) {
                                    node.board.digitalWrite(node.pin, node.board.HIGH);
                                }
                                if ((msg.payload === false)||(msg.payload.toString() == "0")||(msg.payload.toString().toLowerCase() == "off")) {
                                    node.board.digitalWrite(node.pin, node.board.LOW);
                                }
                            }
                            if (node.state === "PWM") {
                                node.board.pinMode(node.pin, 0x03);
                                msg.payload = parseInt((msg.payload * 1) + 0.5);
                                if ((msg.payload >= 0) && (msg.payload <= 255)) {
                                    node.board.analogWrite(node.pin, msg.payload);
                                }
                            }
                            if (node.state === "SERVO") {
                                node.board.pinMode(node.pin, 0x04);
                                msg.payload = parseInt((msg.payload * 1) + 0.5);
                                if ((msg.payload >= 0) && (msg.payload <= 180)) {
                                    node.board.servoWrite(node.pin, msg.payload);
                                }
                            }
                            if (node.state === "SYSEX") {
                                node.board.sysexCommand(msg.payload);
                            }
                            if (node.state === "STRING") {
                            node.board.sendString(msg.payload.toString());
                        }
                        }
                    });
                    node.board.once('disconnect', function() {
                        node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
                        if (node.running) { setTimeout(function() { node.running = false; startup(); }, 5500); }
                    });
                }
                if (node.board.isReady) { doit(); }
                else { node.board.once("ready", function() { doit(); }); }
                setTimeout(function() { if (!node.running) { startup(); } }, 4500);
            }
            startup();
        }
        else {
            node.warn(RED._("arduino.errors.portnotconf"));
        }
        node.on('close', function() {
            node.running = false;
        });
    }
    RED.nodes.registerType("arduino out",DuinoNodeOut);

    RED.httpAdmin.get("/arduinoports", RED.auth.needsPermission("arduino.read"), function(req,res) {
        SP.list(function(error, ports) {
            res.json(ports);
        });
    });
}
