#!/bin/bash

tar cz src/ deploy/webtracker.conf > packed.tgz

bin/kvm-precise deploy/userdata.txt packed.tgz

rm -fr packed.tgz
