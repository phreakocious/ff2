.PHONY: test clean

ff2.zip: manifest.json background.js ff-16.png ff-48.png ff-128.png
	rm -f $@
	zip $@ $^

test:
	node test.js

clean:
	rm -f ff2.zip
