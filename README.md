# Owncloud for Filelink
http://www.viguierjust.com

## Description
Owncloud for Filelink makes it easy to send large attachments by uploading those attachments to any Owncloud server and inserting a link to the file into the body of your email.

Owncloud is a popular storage service, and this add-on allows Filelink to make use of it.

## Development Notes
This extension does not fully work yet as it is missing pieces to the OCS REST API (see https://github.com/owncloud/documentation/issues/90). However, it is already possible to connect to an owncloud
account, view the space used and space left, and upload files through Thunderbird when sending an email. The only missing piece is the retrieval of the shared file link from Owncloud API.
