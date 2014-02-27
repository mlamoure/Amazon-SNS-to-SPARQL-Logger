var Buffer = require('buffer').Buffer;
var https  = require('https');
var util = require('util');
var moment = require('moment');
var path = require('path');
var http = require('http');
var N3 = require('n3');
var needle = require('needle');
var JSONConfigurationController = require("./JSONConfigurationController.js");

var configuration;
var server;
var dateformat = "YYYY/MM/DD HH:mm:ss";
var configFileIncPath = path.join(__dirname + '/configuration.json');

var refreshNATIntervalID = undefined;
var amQuitting = false;

function main() {
	configuration = new JSONConfigurationController();
	configuration.setConfiguration(configFileIncPath);
	configuration.on("configComplete", postConfiguration);
	configuration.on("reset", resetConfiguration);
}

function resetConfiguration(callback) {
	unSubscribeAllSNSTopics(function () {
		if (typeof(server) !== 'undefined') {
			console.log("** (" + getCurrentTime() + ") HTTP Server on port " + configuration.data.PrivatePort + " was shut down");
			server.close();
		}

		console.log("** (" + getCurrentTime() + ") Resetting all configuration variables...");

		if (typeof(refreshNATIntervalID) !== 'undefined') {
			clearInterval(refreshNATIntervalID);
			console.log("** (" + getCurrentTime() + ") Resetting NAT/uPNP Settings...");
		}
		refreshNATIntervalID = undefined;

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

		resetConfiguration(function() {
			// some other closing procedures go here
			console.log("** (" + getCurrentTime() + ") All set!  Quitting.");

			process.exit();
		});
	}
})

function postConfiguration() {
	if (configuration.data.UseNATPNP) {
		startPortForwarding();

		refreshNATIntervalID = setInterval(function() {
			startPortForwarding();
        }, configuration.data.NatTTL * 60 * 1000);
	}

	if (configuration.data.snsEndpointURL.length > 0) setEndpointURL();

	createHTTPServer(configuration.data.PrivatePort);
	subscribeAllSNSTopics();
}

function setEndpointURL() {
}

function unSubscribeAllSNSTopics(callback) {
	var completed = 0;

	for (var i in configuration.data.SNSTopics)
	{
		console.log("** (" + getCurrentTime() + ") Unsubscribing to SNS Topic: " + configuration.data.SNSTopics[i].TopicARN);

		configuration.amazonSNSPublisher.unSubscribeSNSTopic(
			configuration.data.SNSTopics[i].SubscriptionArn, 
			function (subscriptionArn) {
				completed++;
				console.log("** (" + getCurrentTime() + ") Waiting for final unsubscription (completed " + completed + " of " + configuration.data.SNSTopics.length + ")");

				if (completed == configuration.data.SNSTopics.length)
				{
					console.log("** (" + getCurrentTime() + ") Completed the final unsubscription...");
					callback();
				}
		});
	}
}

function subscribeAllSNSTopics() {
	for (var i in configuration.data.SNSTopics)
	{
		console.log("** (" + getCurrentTime() + ") Subscribing to SNS Topic: " + configuration.data.SNSTopics[i].TopicARN);

		configuration.amazonSNSPublisher.subscribeSNSTopic(
			configuration.data.SNSTopics[i].TopicARN, 
			configuration.data.snsEndpointURL
		);
	}
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
				var topicArn = postData.TopicArn;

				console.log("** (" + getCurrentTime() + ") Obtained a SNS Subscription Confirmation Token for topic " + topicArn);

				configuration.amazonSNSPublisher.confirmSubscription(
					topicArn, 
					postData.Token,
					function (subscriptionArn) {
						getSNSTopicByArn(topicArn).SubscriptionArn = subscriptionArn;
				});
			}
			else if (postData.Type == "Notification")
			{
				var triples;
				var n3 = N3.Writer();

				var topicArn = postData.TopicArn;
				var snsTopicOptions = getSNSTopicByArn(topicArn);
				var message = JSON.parse(postData.Message);
				var subjectURIPrefix = snsTopicOptions.SubjectURIPrefix;
				var subjectType = snsTopicOptions.SubjectType;
				var filterField = snsTopicOptions.FilterField;
				var filterValue = snsTopicOptions.FilterValue;
				var objectTypes = snsTopicOptions.ObjectTypes;
				var passFilterTest = false;
				var filter = false;
				var convertTypes = false;

				if (typeof(filterField) !== 'undefined') {
					if (typeof(message[filterField]) !== 'undefined') {
						filter = true;						
					}
				}

				if (typeof(objectTypes) !== 'undefined') {
					if (objectTypes.length > 0) {
						convertTypes = true;
					}
				}

				// check to see if contains a trailing slash, add one if not.
				if (subjectURIPrefix[subjectURIPrefix.length-1] != "/") {
					subjectURIPrefix += "/";
				}

				var subject = subjectURIPrefix + postData.MessageId;
				var object;
				var predicate;

				console.log("** (" + getCurrentTime() + ") Got a SNS Notification POST, Message Recieved: ");
				console.log(message);	

				n3.addTriple(subject, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', subjectType);

				for(var messageAttr in message)
				{
					predicate = subjectURIPrefix + "#" + messageAttr;
					if (filter) {
//						console.log("** (" + getCurrentTime() + ") Checking for the filter field.");

						if (messageAttr.toString().toUpperCase() == filterField.toString().toUpperCase()) {
							if (filterValue.toString().toUpperCase() == message[messageAttr].toString().toUpperCase()) {
								passFilterTest = true;
							}
						}
					}

					if (convertTypes) {
						for (var counter = 0; counter < objectTypes.length; counter++) {
							if (messageAttr.toString().toUpperCase() == objectTypes[counter].property.toString().toUpperCase()) {
								if (objectTypes[counter].convert == "JSONtoRDFDateTime") {
									var d = moment(message[messageAttr]);
									object = "\"" + d.format("YYYY-MM-DDTHH:mm:ss") + "^^" + objectTypes[counter].type + "\"";
								}
								else {
									object = "\"" + message[messageAttr] + "^^" + objectTypes[counter].type + "\"";
								}
							}
						}
					}

					if (typeof(object) === 'undefined') {
						object = "\"" + message[messageAttr] + "\"";
					}


					if (configuration.data.debug) {
						console.log("**********************************")					
						console.log("About to add the triple: ");
						console.log("Subject: " + subject);
						console.log("Predicate: " + predicate);
						console.log("Object: " + object);	
						console.log("**********************************")					
					}

					n3.addTriple(subject, predicate, object);

					object = undefined;
				}

				if (configuration.data.debug) {
					console.log("** (" + getCurrentTime() + ") filter: " + filter.toString() + " passFilterTest: " + passFilterTest.toString());
				}


				if (!filter || passFilterTest)
				{
					n3.end(function (error, result) {
						var sparql = "INSERT DATA {" + result + "}";

						if (!configuration.data.FakePublish) {
							console.log("** (" + getCurrentTime() + ") SPARQL Statement about to be executed: " + sparql);
							logToRDF(sparql);
						}
						else {
							console.log("** (" + getCurrentTime() + ") Not going to execute sparql statement because fakePublish flag is set: " + sparql);
						}
					});
				}
				else if (configuration.data.debug) {
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
    else if (configuration.data.debug)
    {
		console.log("** (" + getCurrentTime() + ") Got a GET, but do not know why...");
		console.log(request.param);
	}

    response.writeHead(200);
    response.end();
}

function logToRDF(sparql) {
	needle.post(configuration.data.SPARQL_Update_Endpoint, { update: sparql }, 
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

	console.log("** (" + getCurrentTime() + ") Using uPNP to port forward on : " + configuration.data.PublicPort + "/" + configuration.data.PrivatePort);
	var client = natUpnp.createClient();

	client.portMapping({
		public: configuration.data.PublicPort,
		private: configuration.data.PrivatePort,
		ttl: configuration.data.NatTTL
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

function getSNSTopicByArn(topicArn) {
	for (var i in configuration.data.SNSTopics)
	{
		if (configuration.data.SNSTopics[i].TopicARN == topicArn)
		{
			return configuration.data.SNSTopics[i];
		}
	}
}

main();