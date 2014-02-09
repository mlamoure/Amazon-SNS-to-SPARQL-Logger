var Buffer = require('buffer').Buffer;
var https  = require('https');
var AWS = require('aws-sdk');
var util = require('util');
var moment = require('moment');
var fs = require('fs');
var path = require('path');
var http = require('http');
var N3 = require('n3');
var needle = require('needle');
var sleep = require('sleep');

var AWS_SNS;
var server;

var dateformat = "YYYY/MM/DD HH:mm:ss";
var useNATPMP;
var snsSubscriptionTopics;
var snsEndpointURL;
var snsEndpointPrivatePort;
var snsEndpointPublicPort;

var refreshNATIntervalID = "undefined";
var natTTL;

var amQuitting = false;

var sparqlUpdateEndpoint;
var portForwardingRefreshRate;

var configFileIncPath = path.join(__dirname + '/configuration.json');

function main() {
	natTTL = 100;
	portForwardingRefreshRate = (natTTL - 5) * 1000 * 60;

	loadConfiguration(function() {
		postConfigurationSettings();

		// watch the configuration file for changes.  reload if anything changes
		fs.watchFile(configFileIncPath, function (event, filename) {
			console.log("** (" + getCurrentTime() + ") RELOADING CONFIGURATION");

			resetAll(function() {
				loadConfiguration(function() {
					postConfigurationSettings();
				});
			})	
		});

	});	
}

function resetAll(callback) {
	unSubscribeAllSNSTopics(function () {
		sleep.sleep(5);

		if (server != null) {
			console.log("** (" + getCurrentTime() + ") HTTP Server on port " + snsEndpointPrivatePort + " was shut down");
			server.close();
		}

		console.log("** (" + getCurrentTime() + ") Resetting all configuration variables...");

		// configure AWS 
		AWS.config.update({
			'region': 'none',
		    'accessKeyId': 'none',
		    'secretAccessKey': 'none'
		});
		
		snsSubscriptionTopics = undefined;
		snsEndpointURL = undefined;
		useNATPMP = undefined;
		snsEndpointPrivatePort =  undefined;
		snsEndpointPublicPort = undefined;
		sparqlUpdateEndpoint = undefined;


		if (refreshNATIntervalID != "undefined") {
			clearInterval(refreshNATIntervalID);
			console.log("** (" + getCurrentTime() + ") Resetting NAT/uPNP Settings...");
		}
		refreshNATIntervalID = "undefined";

		if (callback != null) {
			console.log("** (" + getCurrentTime() + ") Completed resetting...");
			callback();
		}
	});
}

process.on( 'SIGINT', function() {
	if (amQuitting)
	{
		console.log("** (" + getCurrentTime() + ") Already in the process of shutting down, please wait...");
	}
	else
	{
		amQuitting = true;

		console.log("** (" + getCurrentTime() + ") Shutting down... please wait");

		resetAll(function() {
			// some other closing procedures go here
			console.log("** (" + getCurrentTime() + ") All set!  Quitting.");

			process.exit();
		});
	}
})

function postConfigurationSettings() {
	if (useNATPMP) {
		startPortForwarding();

		refreshNATIntervalID = setInterval(function() {
			startPortForwarding();
        }, portForwardingRefreshRate);			
	}

	if (snsEndpointURL.length > 0) setEndpointURL();

	createHTTPServer(snsEndpointPrivatePort);
	subscribeAllSNSTopics();
}

function setEndpointURL() {
}

function unSubscribeAllSNSTopics(callback) {
	var completed = 0;

	for (var i in snsSubscriptionTopics)
	{
		console.log("** (" + getCurrentTime() + ") Unsubscribing to SNS Topic: " + snsSubscriptionTopics[i].TopicARN);

		unSubscribeSNSTopic(snsSubscriptionTopics[i].SubscriptionArn, function (subscriptionArn) {
//			console.log("** (" + getCurrentTime() + ") Waiting for final unsubscription (SubscriptionArn: " + snsSubscriptionTopics[snsSubscriptionTopics.length - 1].SubscriptionArn + ") to complete.  Completed SubscriptionArn: " + subscriptionArn);
			completed++;
			console.log("** (" + getCurrentTime() + ") Waiting for final unsubscription (completed " + completed + " of " + snsSubscriptionTopics.length + ")");

			// is it the final unsubscrition?  Once all finished, call back.
//			if (subscriptionArn == snsSubscriptionTopics[snsSubscriptionTopics.length - 1].SubscriptionArn)
			if (completed == snsSubscriptionTopics.length)
			{
				console.log("** (" + getCurrentTime() + ") Completed the final unsubscription...");
				callback();
			}
		});
//		snsSubscriptionTopics[i].SubscriptionArn = undefined;
	}
}

function subscribeAllSNSTopics() {
	for (var i in snsSubscriptionTopics)
	{
		console.log("** (" + getCurrentTime() + ") Subscribing to SNS Topic: " + snsSubscriptionTopics[i].TopicARN);

		subscribeSNSTopic(snsSubscriptionTopics[i].TopicARN, snsEndpointURL);
	}
}

function subscribeSNSTopic(topic, endpointURL) {	 
	AWS_SNS.subscribe({
	    'TopicArn': topic,
	    'Protocol': 'http',
	    'Endpoint': endpointURL
	}, function (err, result) {
	 
	    if (err !== null) {
			console.log("** (" + getCurrentTime() + ") Error:");
	        console.log(util.inspect(err));
	        return;
	    }
		console.log("** (" + getCurrentTime() + ") Sent a subscription request for topic " + topic + " and Amazon responded with:");
		console.log(result);
	});
}

function unSubscribeSNSTopic(subscriptionArn, callback) {	 
	AWS_SNS.unsubscribe({
	    'SubscriptionArn': subscriptionArn
	}, function (err, result) {
	 
	    if (err !== null) {
			console.log("** (" + getCurrentTime() + ") Error:");
	        console.log(util.inspect(err));
	        return;
	    }
		console.log("** (" + getCurrentTime() + ") Sent a unsubscription request for SubscriptionArn " + subscriptionArn + " and Amazon responded with:");
		console.log(result);

		if (callback != null) callback(subscriptionArn);
	});
}

function createHTTPServer(port) {
	server = http.createServer(parsePOST).listen(port);
	console.log("** (" + getCurrentTime() + ") HTTP Server has started on Port " + port);
}

function parsePOST(request, response) {
	if (request.method == 'POST') {
		var body = '';
		request.on('data', function (data) {
			body += data;
		});
		request.on('end', function () {

			var postData = JSON.parse(body);

			if (postData.Type == "SubscriptionConfirmation")
		    {
				var topic = postData.TopicArn;

				console.log("** (" + getCurrentTime() + ") Obtained a SNS Subscription Confirmation Token for topic " + topic);

				AWS_SNS.confirmSubscription({
				    'TopicArn': topic,
				    'Token': postData.Token,
				}, function (err, result) {
				 
				    if (err !== null) {
						console.log("** (" + getCurrentTime() + ") ERROR: ");
						console.log(util.inspect(err));
						return;
				    }

					console.log("** (" + getCurrentTime() + ") Responded with a Confirmation for topic " + topic + " and recieved SubscriptionARN: " + result.SubscriptionArn);

					getSNSTopicConfigOptions(topic)["SubscriptionArn"] = result.SubscriptionArn;
				});
			}
			else if (postData.Type == "Notification")
			{
				var triples;
				var n3 = N3.Writer();

				var topic = postData.TopicArn;
				var snsTopicOptions = getSNSTopicConfigOptions(topic);
				var message = JSON.parse(postData.Message);
				var subjectURIPrefix = snsTopicOptions.SubjectURIPrefix;
				var subjectType = snsTopicOptions.SubjectType;
				var filterField = snsTopicOptions.FilterField;
				var filterValue = snsTopicOptions.FilterValue;
				var passFilterTest = false;
				var filter = false;

				if (typeof(filterField) !== 'undefined') {
					if (typeof(message[filter]) !== 'undefined') {
						filter = true;						
					}
				}

				// check to see if contains a trailing slash, add one if not.
				if (subjectURIPrefix[subjectURIPrefix.length-1] != "/") {
					subjectURIPrefix += "/";
				}

				var subject = subjectURIPrefix + postData.MessageId;

				console.log("** (" + getCurrentTime() + ") Got a SNS Notification POST, Message Recieved: ");
				console.log(message);	

				n3.addTriple(subject, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', subjectType);

				for(var messageAttr in message)
				{
					if (filter) {
						if (messageAttr.toString().toUpperCase() == filterField.toString().toUpperCase()) {
							if (filterValue.toString().toUpperCase() == message[messageAttr].toString().toUpperCase()) {
								passFilterTest = true;
							}
						}
					}
					n3.addTriple(subject, subjectURIPrefix + "#" + messageAttr, "\"" + message[messageAttr] + "\"")
				}

				if (!filter || passFilterTest)
				{
					n3.end(function (error, result) {
						var sparql = "INSERT DATA {" + result + "}";
						console.log("** (" + getCurrentTime() + ") SPARQL Statement about to be executed: " + sparql);

						logToRDF(sparql);
					});
				}
				else {
					console.log("** (" + getCurrentTime() + ") Will not record becase a filter criteria has not been met.");
				}
		    }
		    else
		    {
				console.log("** (" + getCurrentTime() + ") Got a POST, but do not know what to do with it! body:");
				console.log(body);
				console.log("** (" + getCurrentTime() + ") ... and Headers for the POST " + request.headers);				
		    }
        });
    }
    else
    {
		console.log("** (" + getCurrentTime() + ") Got a GET, but do not know why...");
		console.log(request.param);
	}

    response.writeHead(200);
    response.end();
}

function logToRDF(sparql) {
	needle.post(sparqlUpdateEndpoint, { update: sparql }, 
	    function(err, resp, body){

	    	if (body.indexOf("Update succeeded") > 0)
	    	{
				console.log("** (" + getCurrentTime() + ") The SPARQL Update was sucessful");
	    	}
	    	else
	    	{
				console.log("** (" + getCurrentTime() + ") ERROR: The SPARQL Update was NOT sucessful:");
				console.log(body);
	    	}
	});	
}

function startPortForwarding() {
	var natUpnp = require('nat-upnp');

	console.log("** (" + getCurrentTime() + ") Using uPNP to port forward on : " + snsEndpointPublicPort + "/" + snsEndpointPrivatePort);
	var client = natUpnp.createClient();

	client.portMapping({
		public: snsEndpointPublicPort,
		private: snsEndpointPrivatePort,
		ttl: natTTL
	}, function(err) {
		if (err != null)
		{
			console.log("** (" + getCurrentTime() + ") ERROR: uPNP was NOT sucessful");
		}
	});
}

function getCurrentTime() {
	return (moment().format(dateformat));
}

function getSNSTopicConfigOptions(topic) {
	for (var i in snsSubscriptionTopics)
	{
		if (snsSubscriptionTopics[i].TopicARN == topic)
		{
			return snsSubscriptionTopics[i];
		}
	}
}

function loadConfiguration(callback) {
	fs.readFile(configFileIncPath, 'utf8', function (err, data) {
		if (err) {
			console.log("** (" + getCurrentTime() + ") ERROR LOADING CONFIGURATION: " + err);
			return;
		}

		var configuration = JSON.parse(data);

		console.log("** (" + getCurrentTime() + ") CONFIGURATION: Adding AWS credentials");

		// configure AWS 
		AWS.config.update({
			'region': configuration.AWS.defaultRegion,
		    'accessKeyId': configuration.AWS.accessKeyId,
		    'secretAccessKey': configuration.AWS.secretAccessKey
		});
		
		snsSubscriptionTopics = configuration.SNSTopics;

		if (configuration.snsEndpointURL.length > 0)
		{
			snsEndpointURL = configuration.snsEndpointURL;
			console.log("** (" + getCurrentTime() + ") CONFIGURATION: the endpoint was manually set to " + snsEndpointURL);
		}

		useNATPMP = configuration.UseNATPNP;
		console.log("** (" + getCurrentTime() + ") CONFIGURATION: NAT Portforwarding is enabled?: " + useNATPMP);

		snsEndpointPrivatePort =  configuration.PrivatePort;
		snsEndpointPublicPort = configuration.PublicPort;
		console.log("** (" + getCurrentTime() + ") CONFIGURATION: Public Port set to " + snsEndpointPublicPort);
		console.log("** (" + getCurrentTime() + ") CONFIGURATION: Private Port set to " + snsEndpointPrivatePort);

		AWS_SNS = new AWS.SNS().client;		

		sparqlUpdateEndpoint = configuration.SPARQL_Update_Endpoint;

		if (callback != null) callback();		
	});
}

main();