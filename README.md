Simple Amazon SNS client written in Node.js that will publish to a SPARQL endpoint.  Requires Moment.js, needle, and the node.js AWS SDK to run.

The server is designed to listen perpetually for messages and convert basic key/value objects from JSON to RDF without any coding.  The configuration file allows you to specify patterns for each SNS topic to create the proper subject, and predicate.  Subjects are prefaced with a prefix via configuration.  Predicates can be typed which is appended to the object from their dummy JSON strings, booleans, integers, etc.

Some automation typing is on my list of to-dos down the road.  For now, you have to statically define the type in the config.  Properties/predicates without a type are added without typing.

This is a great option to persist messages in RDF rather than writing them to a JSON store.  RDF is preferred over JSON because of the standardized and robust query language that it has, as well as RDF's clarity around typing.