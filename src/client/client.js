import localforage from "https://unpkg.com/localforage@1.9.0/src/localforage.js";

var loginBtn = document.getElementById('loginBtn'); 
var sendMessageBtn = document.getElementById('sendMessageBtn');
var chatMessages = document.getElementById('chatMessages');

var loginInput = document.getElementById('loginInput');
var chatNameInput = document.getElementById('chatNameInput');
var messageInput = document.getElementById('messageInput');

var connectedUser, localConnection, sendChannel;
var localUsername;

// TODO: massive fucking techdebt of modularising
// TODO: replace getItem/setItem with just gets upon login and periodic sets

//////////////////////
// GLOBAL VARIABLES //
//////////////////////

var enc = new TextEncoder();
var dec = new TextDecoder();

// private keypair for the client
var keyPair;

// connection to peerName
var connectionNames = new Map();

const configuration = { 
   "iceServers": [
        { "urls": "stun:stun.12connect.com:3478" },
        { "urls": "stun:openrelay.metered.ca:80" },
        {
            "urls": "turn:openrelay.metered.ca:80",
            "username": "openrelayproject",
            "credential": "openrelayproject",
        },
        {
            "urls": "turn:openrelay.metered.ca:443",
            "username": "openrelayproject",
            "credential": "openrelayproject",
        },
        {
            "urls": "turn:openrelay.metered.ca:443?transport=tcp",
            "username": "openrelayproject",
            "credential": "openrelayproject",
        }
    ] 
}; 

var currentChatID = 0;

// map from peerName:string to {connection: RTCPeerConnection, sendChannel: RTCDataChannel}
var connections = new Map();

// map from chatID to an array of usernames to connect to
var toConnect = new Map();

// (chatID: String, {chatName: String, members: Array of String})
var joinedChats = new Map();

// local cache : localForage instance
var store;

// map from name to public key : Uint8Array
var keyMap = new Map();

// storing deps for faster access
var hashedOps = new Map();


/////////////////////////
// WebSocket to Server //
/////////////////////////

var connection = new WebSocket('wss://ec2-13-40-196-240.eu-west-2.compute.amazonaws.com:3000/'); 
// var connection = new WebSocket('wss://localhost:3000');

connection.onopen = function () { 
    console.log("Connected to server");
};
  
connection.onerror = function (err) { 
    console.log("Error: ", err);
    alert("Please authorise https://ec2-13-40-196-240.eu-west-2.compute.amazonaws.com:3000/ on your device before refreshing! ")
};

function sendToServer(message) {
    console.log(JSON.stringify(message));
    connection.send(JSON.stringify(message)); 
};
  
// Handle messages from the server 
connection.onmessage = function (message) { 
    console.log("Got message", message.data);
    var data = JSON.parse(message.data); 
	
    switch(data.type) { 
        case "login": 
            onLogin(data.success, new Map(JSON.parse(data.joinedChats))); 
            break; 
        case "offer": 
            onOffer(data.offer, data.from); 
            break; 
        case "answer": 
            onAnswer(data.answer, data.from); 
            break; 
        case "candidate": 
            onCandidate(data.candidate, data.from); 
            break;
        case "usernames":
            onUsernames(data.usernames);
            break;
        case "join":
            onJoin(data.usernames);
            break;
        case "leave":
            onLeave(data.from);
            break;
        case "createChat":
            onCreateChat(data.chatID, data.chatName, new Map(JSON.parse(data.validMemberPubKeys)), data.invalidMembers);
            break;
        case "add":
            onAdd(data.chatID, data.chatName, data.from);
            break;
        default: 
            break; 
   } 
};
  
// Server approves Login
function onLogin(success, chats) { 

    if (success === false) { 
        alert("oops...try a different username"); 
    } else {
        localUsername = loginInput.value;
        joinedChats = chats;
        updateHeading();

        initialiseStore();
    } 
};

function initialiseStore () {
    // new user: creates new store
    // returning user: will just point to the same instance
    store = localforage.createInstance({
        name: localUsername
    });

    store.setItem("keyPair", keyPair);
    store.setItem("joinedChats", joinedChats);
}

// Sending Offer to Peer
function sendOffer(peerName, chatID) {
    
    if (peerName !== null) { 
        const newConnection = initPeerConnection(peerName);
        connections.set(peerName, {connection: newConnection, sendChannel: null});
        connectionNames.set(newConnection, peerName);
        const peerConnection = connections.get(peerName);

        const channelLabel = {
            senderUsername: localUsername, 
            receiverUsername: peerName,
            chatID: chatID,
        };
        peerConnection.sendChannel = peerConnection.connection.createDataChannel(JSON.stringify(channelLabel));
        initChannel(peerConnection.sendChannel);
        console.log(`Created sendChannel for ${localUsername}->${peerName}`);

        console.log(`Sending offer to ${peerName}`);
        peerConnection.connection.createOffer(function (offer) { 
            sendToServer({
                to: peerName,
                type: "offer",
                offer: offer 
            });
                
            peerConnection.connection.setLocalDescription(offer);
        }, function (error) { 
            alert("An error has occurred."); 
        }); 
    }
}; 

// Receiving Offer + Sending Answer to Peer
function onOffer(offer, peerName) { 
    connections.set(peerName, {connection: initPeerConnection(), sendChannel: null});
    const peerConnection = connections.get(peerName);

    peerConnection.connection.setRemoteDescription(offer);

    console.log(`Sending answer to ${peerName}`);
    peerConnection.connection.createAnswer(function (answer) {
        peerConnection.connection.setLocalDescription(answer);
        sendToServer({ 
            to: peerName,
            type: "answer", 
            answer: answer 
        }); 
    }, function (error) { 
        alert("oops...error"); 
    });
}
  
// Receiving Answer from Peer
function onAnswer(answer, peerName) {
    connections.get(peerName).connection.setRemoteDescription(answer);
} 
 
// Receiving ICE Candidate from Server
function onCandidate(candidate, peerName) {
    if (connections.has(peerName)) {
        connections.get(peerName).connection.addIceCandidate(new RTCIceCandidate(candidate)); 
    }
}

function onUsernames(usernames) {
    if (usernames.length > 0) {
        document.getElementById('usernames').innerHTML = `Currently Online: ${usernames.join(", ")}`;
    }
}

// Depreciated: For now
function onJoin (usernames) {
    for (peerName of usernames) {
        if (!connections.has(peerName) && peerName !== localUsername) {
            sendOffer(peerName);
        }
    }
}

function onLeave (peerName) {
    connectionNames.delete(connections.get(peerName).connection);
    connections.get(peerName).sendChannel.close();
    connections.get(peerName).connection.close();
    updateChatWindow({from: "SET", message: `${peerName} has left the room`});
    connections.delete(peerName);
}

async function onCreateChat (chatID, chatName, validMemberPubKeys, invalidMembers) {

    joinedChats.set(chatID, {chatName: chatName, members: []});
    store.setItem("joinedChats", joinedChats);
    
    for (const mem of validMemberPubKeys.keys()) {
        console.log(`adding ${mem} with pk ${validMemberPubKeys.get(mem)} to keyMap`);
        keyMap.set(mem, enc.encode(validMemberPubKeys.get(mem)));
    }
    
    if (invalidMembers.length > 0) {
        alert(`The following users do not exist ${invalidMembers}`);
    }

    const createOp = await generateOp("create", chatID);
    const operations = new Set([createOp]);

    store.setItem(chatID, {
        metadata: {
            chatName: chatName,
            operations: operations,
            ignored: new Set()
        },
        history: new Map(),
    }).then(() => {
        addToChat(validMemberPubKeys, chatID);
    });

    updateChatOptions("add", chatID);
    updateHeading();
}

// When being added to a new chat
// (chatID: String, {chatName: String, members: Array of String})
function onAdd (chatID, chatName, from) {
    console.log(`you've been added to chat ${chatName} by ${from}`);
    joinedChats.set(chatID, {chatName: chatName, members: []});

    store.setItem(chatID, {
        metadata: {
            chatName: chatName,
            operations: new Set(),
            ignored: new Set()
        },
        history: new Map(),
    });

    // now we have to do syncing to get members and add to store
    sendOffer(from, chatID);
    
    updateChatOptions("add", chatID);
    updateHeading();
}

async function addToChat(validMemberPubKeys, chatID) {
    // members is the list of members pubkey: string to add to the chat
    store.getItem(chatID).then(async (chatInfo) => {
        return new Promise(async (resolve) => {
            for (const mem of validMemberPubKeys.keys()) {
                console.log(`${validMemberPubKeys.get(mem)}   ${Uint8Array.from(Object.values(validMemberPubKeys.get(mem)))}`);
                const op = await generateOp("add", chatID, Uint8Array.from(Object.values(validMemberPubKeys.get(mem))), chatInfo.metadata.operations);
                chatInfo.metadata.operations.add(op);
                console.log(`added ${mem} to chat`);

                const sentTime = Date.now();
                broadcastToMembers({
                    id: nacl.hash(enc.encode(`${localUsername}:${sentTime}`)),
                    type: "add",
                    op: op,
                    from: localUsername,
                    name: mem,
                    sentTime: sentTime
                }, chatID);
                sendToServer({
                    to: mem,
                    type: "add",
                    chatID: chatID,
                    chatName: chatInfo.metadata.chatName
                });
                console.log(`added ${mem}`);
            }
            resolve(chatInfo);
        });
    }).then((chatInfo) => {
        store.setItem(chatID, chatInfo).then(console.log(`${[...validMemberPubKeys.keys()]} have been added to ${chatID}`));
    });
}

//////////////////////////////
// Access Control Functions //
//////////////////////////////

function getDeps (operations) {
    var deps = new Set();
    console.log(operations);
    for (const op of operations) {
        const hashedOp = hashOp(op);
        if (op.action === "create" || (op.action !== "create" && !op.deps.has(hashedOp))) {
            deps.add(hashedOp);
            console.log(`dependency ${op.pk}${op.pk1} ${op.action} ${op.pk2}`);
        }
    }
    console.log([...deps]);
    return deps;
}

function concatOp (op) {
    return op.action === "create" ? `${op.action}${op.pk}${op.nonce}` : `${op.action}${op.pk1}${op.pk2}${op.deps}`;
}

async function generateOp (action, chatID, pk2 = null, ops = new Set()) {
    // pk is uint8array
    
    return new Promise(function(resolve) {
        var op;
        if (action === "create") {
            op = {
                action: 'create', 
                pk: keyPair.publicKey,
                nonce: nacl.randomBytes(64),
            };
        } else if (action === "add" || action === "remove") {
            console.log(`adding operation ${keyPair.publicKey} ${action}s ${pk2}`);
            op = {
                action: action, 
                pk1: keyPair.publicKey,
                pk2: pk2,
                deps: [...getDeps(ops)]
            };
        }
        console.log(`encoded ${enc.encode(concatOp(op)) instanceof Uint8Array}, length of sig ${nacl.sign.detached(new TextEncoder().encode(concatOp(op)), keyPair.secretKey).length}`);
        op["sig"] = nacl.sign.detached(enc.encode(concatOp(op)), keyPair.secretKey);
            resolve(op);
    });
}

async function sendOperations (chatID, username) {
    console.log(`sending operations`);
    store.getItem(chatID).then((chatInfo) => {
        sendToMember({
            type: "ops",
            ops: [...chatInfo.metadata.operations],
            chatID: chatID,
            from: localUsername,
        }, username);
    });
}

function unpackOp(op) {
    console.log(op.deps);
    op.sig = Uint8Array.from(Object.values(op.sig));
    if (op.action === "create") {
        op.pk = Uint8Array.from(Object.values(op.pk));
        op.nonce = Uint8Array.from(Object.values(op.nonce));
    } else {
        op.pk1 = Uint8Array.from(Object.values(op.pk1));
        op.pk2 = Uint8Array.from(Object.values(op.pk2));
    }
}

async function receivedOperations (ops, chatID, username) {
    // ops: array of operation objectss
    console.log(`receiving operations`);
    ops.forEach(op => unpackOp(op));
    store.getItem(chatID).then((chatInfo) => {
        ops = new Set([...chatInfo.metadata.operations, ...ops]);
        console.log(`verified ${verifyOperations(ops)} is member ${members(ops, chatInfo.metadata.ignored).has(keyMap.get(username))}`);
        if (verifyOperations(ops) && members(ops, chatInfo.metadata.ignored).has(keyMap.get(username))) {
            chatInfo.metadata.operations = ops;
            store.setItem(chatID, chatInfo);
            console.log(`synced with ${username}`);
        }
    });
}

// takes in set of ops
function verifyOperations (ops) {
    
    // only one create
    ops = [...ops];
    const createOps = ops.filter((op) => op.action === "create");
    if (createOps.length != 1) { console.log("op verification failed: more than one create"); return false; }
    const createOp = createOps[0];
    if (!nacl.sign.detached.verify(enc.encode(concatOp(createOp)), createOp.sig, createOp.pk)) { console.log("op verification failed: create key verif failed"); return false; }

    const otherOps = ops.filter((op) => op.action !== "create");
    const hashedOps = ops.map((op) => hashOp(op));

    for (const op of otherOps) {
        // valid signature
        if (!nacl.sign.detached.verify(enc.encode(concatOp(op)), op.sig, op.pk1)) { console.log("op verification failed: key verif failed"); return false; }

        // non-empty deps and all hashes in deps resolve to an operation in o
        for (const dep of op.deps) {
            if (!hashedOps.includes(dep)) { console.log("op verification failed: missing dep"); return false; } // as we are transmitting the whole set
        }
    }

    return true;
}

function hashOp(op) {
    return dec.decode(nacl.hash(enc.encode(concatOp(op))));
}

function getOpFromHash(ops, hashedOp) {
    if (hashedOps.has(hashedOp)) { return hashedOps.get(hashedOp); }
    for (const op of ops) {
        if (hashedOp == hashOp(op)) {
            hashedOps.set(hashedOp, op);
            return op;
        }
    }
}

// takes in set of ops
function precedes (ops, op1, op2) {
    if (!ops.has(op2) || !ops.has(op1)) { return false; } // TODO
    const toVisit = [op2];
    const target = hashOp(op1);
    var curOp;
    var dep;
    while (toVisit.length > 0) {
        curOp = toVisit.shift();
        console.log(`for op ${curOp.action} ${curOp.deps}`);
        for (const hashedDep of curOp.deps) {
            if (hashedDep === target) {
                return true;
            } else {
                dep = getOpFromHash(ops, hashedDep);
                if (dep.action !== "create") {
                    toVisit.push(dep);
                }
            }
        }
    }
    return false;
}

function concurrent (ops, op1, op2) {
    if (!ops.has(op1) || !ops.has(op2) || op1.sig === op2.sig || precedes(ops, op1, op2) || precedes(ops, op2, op1)) { return false; }
    return true;
}

function printEdge(edge) {
    console.log(`edge: ${edge[0].action} to ${edge[1].action}${edge[1].member}`);
}

function authority (ops) {
    const edges = new Set();
    var pk;
    // convert pk into strings to perform comparisons
    for (const op1 of ops) {
        console.log(concatOp(op1));
        for (const op2 of ops) {
            if (op2.action === "create") { continue; }
            pk = dec.decode(op2.pk1);
            console.log(`sig type ${op1.sig}   op1.action ${op1.action}`);
            console.log(`sig type ${op2.sig}   op1.action ${op2.action}`);
            console.log(`${op1.action} precedes ${op2.action}? ${precedes(ops, op1, op2)}`);
            if ((((op1.action === "create" && dec.decode(op1.pk) === pk) || (op1.action === "add" && dec.decode(op1.pk2) === pk)) && precedes(ops, op1, op2))
                || ((op1.action === "remove" && op1.pk2 === pk) && (precedes(ops, op1, op2) || concurrent(ops, op1, op2)))) {
                edges.add([op1, op2]);
                console.log(`adding edge ${op1.action} to ${op2.action}`);
            }
        }

        pk = op1.action == "create" ? op1.pk : op1.pk2;
        edges.add([op1, {"member": pk, "sig": pk}]);
        console.log(`adding member ${pk}`)  // TODO: remove dups
    }
    [...edges].forEach(e => printEdge(e));

    return edges;
}

function valid (ops, ignored, op) {
    if (op.action === "create") { return true; }
    if (ignored.has(op)) { return false; }
    const inSet = ([...authority(ops)]).filter((edge) => {
        const op1 = edge[0];
        const op2 = edge[1];
        return dec.decode(op.sig) == dec.decode(op2.sig) && valid(ops, ignored, op1);
    }).map(edge => edge[0]);
    console.log(`inSet, meant to represent the functions that affect op ${inSet.map(x => concatOp(x))}`);
    const removeIn = inSet.filter(r => (r.action === "remove"));
    for (const opA of inSet) {
        if (opA.action === "create" || opA.action === "add") {
            if (removeIn.filter(opR => precedes(ops, opA, opR)).length === 0) {
                return true;
            }
        }
    }
    return false;
}

function members (ops, ignored) {
    const pks = new Set();
    var pk;
    for (const op of ops) {
        pk = op.action === "create" ? op.pk : op.pk2;
        if (valid(ops, ignored, {"member": pk, "sig": pk})) {
            pks.add(pk);
        }
    }
    console.log(`calculated member set ${[...pks]}`);
    return pks;
}


////////////////////////////
// Peer to Peer Functions //
////////////////////////////

function joinChat (chatID) {
    if (currentChatID !== chatID) {
        currentChatID = chatID;
        for (peerName of joinedChats.get(chatID).members) {
            if (peerName !== localUsername) {
                // Insert Key Exchange Protocol
                sendOffer(peerName, chatID);
            }
        }
    }
}

function initPeerConnection () {
    try {
        const connection = new RTCPeerConnection(configuration);
        connection.ondatachannel = receiveChannelCallback;
        connection.onicecandidate = function (event) {
            console.log("New candidate");
            if (event.candidate) {
                sendToServer({ 
                    type: "candidate", 
                    candidate: event.candidate,
                    name: localUsername,
                    chatroomID: currentChatID
                });
            }
        };
        connection.oniceconnectionstatechange = function (event) {
            if (connection.iceConnectionState === "failed") {
                console.log("Restarting ICE");
                connection.restartIce();
            }
        }
        connection.onconnectionstatechange = function (event) {
            console.log(event);
            if (connection.connectionState === "failed") {
                console.log("Restarting ICE");
                connection.restartIce();
            }
        }
        connection.onnegotiationneeded = function (event) {
            console.log("On negotiation needed")
            if (connection.connectionState === "failed") {
                connection.createOffer(function (offer) { 
                    sendToServer({
                        to: connectionNames.get(connection),
                        type: "offer",
                        offer: offer 
                    });
                    connection.setLocalDescription(offer);
                }, function (error) { 
                    alert("An error has occurred."); 
                }, function () {
                    console.log("Create Offer failed");
                }, {
                    iceRestart: true
                });
            }
        }
        console.log("Local RTCPeerConnection object was created");
        return connection;
    } catch (e) {
        console.error(e);
        return null;
    }
}

function initChannel (channel) {
    channel.onopen = (event) => { 
        console.log(event);
        console.log(`Channel ${event.target.label} opened`);
        const channelLabel = JSON.parse(event.target.label);
        sendOperations(channelLabel.chatID, channelLabel.senderUsername === localUsername ? channelLabel.receiverUsername : channelLabel.senderUsername);
    }
    channel.onclose = (event) => { console.log(`Channel ${event.target.label} closed`); }
    channel.onmessage = (event) => {
        const messageData = JSON.parse(event.data);
        if (messageData.type === "ops") {
            receivedOperations(messageData.ops, messageData.chatID, messageData.from);
        } else {
            updateChatStore(messageData);
            updateChatWindow(messageData);
        }
    }
}

function receiveChannelCallback (event) {
    const channelLabel = JSON.parse(event.channel.label);
    console.log(`Received channel ${event.channel.label} from ${channelLabel.senderUsername}`);
    const peerConnection = connections.get(channelLabel.senderUsername);
    peerConnection.sendChannel = event.channel;
    initChannel(peerConnection.sendChannel);
}

function updateChatWindow (data) {
    if (data.chatID === currentChatID) {
        var message;
        switch (data.type) {
            case "text":
                message = `[${data.sentTime}] ${data.from}: ${data.message}`;
                break;
            case "add":
                message = `[${data.sentTime}] ${data.from} added ${data.name}`;
                break;
            case "remove":
                message = `[${data.sentTime}] ${data.from} removed ${data.name}`;
                break;
            default:
                message = "";
                break;
        }
        const msg = `${chatMessages.innerHTML}<br />${message}`;
        chatMessages.innerHTML = msg;
    }
}

function updateChatStore (messageData) {
    store.getItem(messageData.chatID).then((chatInfo) => {
        chatInfo.history.set(messageData.id, messageData);
        store.setItem(chatID, chatInfo);
    }).then(() => {
        console.log("updated chat store");
    });
}

function sendToMember (data, username) {
    console.log(`sending ${JSON.stringify(data)}   to ${username}`);
    connections.get(username).sendChannel.send(JSON.stringify(data));
}

function broadcastToMembers (data, chatID = null) {
    chatID = chatID === null ? currentChatID : chatID;
    for (const username of joinedChats.get(chatID).members) {
        try {
            console.log(`sending ${data} to ${username}`);
            sendToMember(data, username);
        } catch {
            continue;
        }
    }
}

function sendChatMessage (messageInput) {
    console.log("message sent");
    const sentTime = Date.now();
    const data = {
        id: nacl.hash(enc.encode(`${localUsername}:${sentTime}`)),
        type: "text",
        from: localUsername,
        message: messageInput,
        sentTime: sentTime,
        chatID: currentChatID
    };

    broadcastToMembers(data);
    updateChatStore(currentChatID, data);
    updateChatWindow(data);
}


/////////////////////
// Event Listeners //
/////////////////////

// Send Login attempt
loginBtn.addEventListener("click", function (event) { 
    const loginInput = document.getElementById('loginInput').value;

    keyPair = nacl.sign.keyPair();
    console.log("keyPair generated");

    if (loginInput.length > 0 && isAlphanumeric(loginInput)) {
        sendToServer({ 
            type: "login", 
            name: loginInput,
            pubKey: keyPair.publicKey
        });
    }
});

messageInput.addEventListener("keypress", function (event) {
    if (event.key === "Enter") {
        event.preventDefault();
        sendMessageBtn.click();
    }
})

sendMessageBtn.addEventListener("click", function () {
    if (messageInput.value.length > 0) {
        sendChatMessage(messageInput.value);
        messageInput.value = "";
    }
})

chatNameInput.addEventListener("change", selectChat);

newChatBtn.addEventListener("click", createNewChat);

function getChatNames() {
    var chatnames = [];
    for (const chatID of joinedChats.keys()) {
        chatnames.push(joinedChats.get(chatID).chatName)
    }
    return chatnames;
}

function getChatID(chatName) {
    console.log(Array.from(joinedChats.keys()));
    for (const chatID of joinedChats.keys()) {
        console.log(chatID);
        if (chatName === joinedChats.get(chatID).chatName) {
            return chatID;
        }
    }
    return -1;
}

function updateHeading() {
    const title = document.getElementById('heading');
    title.innerHTML = `I know this is ugly, but Welcome ${localUsername}`;
    if (joinedChats.size > 0) {
        const availableChats = document.getElementById('availableChats');
        availableChats.innerHTML = `Chats: ${getChatNames().join(", ")}`;
    }
}

function selectChat() {
    const index = chatNameInput.selectedIndex;

    if (index > 0) {
        const chatName = chatNameInput.options.item(index).text;
        currentChatID = getChatID(chatName);
        console.log(`trying to join chatID ${currentChatID}`);

        const chatTitle = document.getElementById('chatHeading');
        chatTitle.innerHTML = `Chat: ${chatName}`;
        chatMessages.innerHTML = "";
        var msg = "";
        store.getItem(currentChatID).then((chatInfo) => {
            for (const mid of chatInfo.history.keys()) {
                const data = chatInfo.history.get(mid);
                msg = `${msg}<br />[${data.setTime}] ${data.from}: ${data.message}`
            }
            chatMessages.innerHTML = msg;
        });
        joinChat(currentChatID);
    }
}

// TODO: distinguish between same name different chat
function updateChatOptions(operation, chatID) {

    if (operation === "add") {
        var option = document.createElement("option");
        option.text = joinedChats.get(chatID).chatName;
        chatNameInput.options.add(option);
    } else {
        
    }
}

function createNewChat() {
    let newChatName = document.getElementById('newChatName').value;
    let member1 = document.getElementById('member1').value;
    let member2 = document.getElementById('member2').value;

    sendToServer({ 
        type: "createChat", 
        chatName: newChatName,
        members: [member1, member2]
    });
}

function isAlphanumeric(str) {
    return str === str.replace(/[^a-z0-9]/gi,'');
}