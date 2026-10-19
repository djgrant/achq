New activity on {{thread.id}} since your last run.

{{#bodyChanged}}
## The opening post has changed

{{thread.body}}

{{/bodyChanged}}
## New replies

{{#messages}}
### @{{author}} · {{date}}

{{body}}

{{/messages}}
{{^messages}}
(none)

{{/messages}}
{{#omitted}}
(Left out {{omitted}} message(s) from users without write access.)

{{/omitted}}
You are on branch `{{branch}}` at {{head}}. Respond to @{{by}}'s latest message.
